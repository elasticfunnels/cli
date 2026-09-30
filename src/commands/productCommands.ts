import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient, ProductImageUpload } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { readJsonPayloadFile } from './shared';
import { formatRelative, renderTable } from '../utils/format';
import { Product } from '../models/product';
import {
    applyBonusEdits,
    bonusSummary,
    buildRule,
    describeRule,
    normalizeBonuses,
    parseBonusSpec,
    splitList,
    toBonusPayload,
} from '../utils/bonuses';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

/**
 * Read a local image file for upload. The server only accepts a product image
 * as a multipart file (the JSON `image`/`image_link` field is read-only), so
 * `--image` always points at a file on disk.
 */
async function readImageUpload(p: string): Promise<ProductImageUpload> {
    const abs = path.resolve(p);
    const name = path.basename(abs);
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new CliError(ExitCode.Validation, `--image must be an image file (${[...IMAGE_EXTENSIONS].join(', ')}); got "${name}".`);
    }
    let bytes: Buffer;
    try {
        bytes = await fs.promises.readFile(abs);
    } catch {
        throw new CliError(ExitCode.Validation, `Image file not found or unreadable: ${p}`);
    }
    return { name, bytes };
}

/**
 * Map of CLI flags → product payload keys. String fields pass through; the
 * `num` set is parsed as numbers. Anything not expressible here (variants,
 * galleries, product files, warehousing) goes through `--file`.
 */
const STRING_FIELDS: Record<string, string> = {
    title: 'title',
    code: 'code',
    checkoutTitle: 'checkout_title',
    description: 'description',
    shortDescription: 'short_description',
    status: 'status',
    type: 'type',
    classification: 'classification',
    currency: 'currency',
    sku: 'sku',
    seoTitle: 'seo_title',
    seoDescription: 'seo_description',
    seoSlug: 'seo_slug',
};
const NUMBER_FIELDS: Record<string, string> = {
    price: 'price',
    retailPrice: 'retail_price',
    units: 'units',
};

function addCommonFlags(cmd: Command): Command {
    return cmd
        .option('--title <title>', 'Product title.')
        .option('--code <code>', 'Product code (unique per brand). Required on create.')
        .option('--checkout-title <text>', 'Checkout title.')
        .option('--description <text>', 'Long description.')
        .option('--short-description <text>', 'Short description.')
        .option('--status <status>', 'draft | active | archived.')
        .option('--type <type>', 'physical | digital | service.')
        .option('--classification <c>', 'main | upsell | downsell | bump | bonus.')
        .option('--price <n>', 'Price.', parseNum)
        .option('--retail-price <n>', 'Retail (compare-at) price.', parseNum)
        .option('--currency <iso>', '3-letter currency code.')
        .option('--sku <sku>', 'SKU.')
        .option('--units <n>', 'Units per product.', parseNum)
        .option('--seo-title <text>', 'SEO title.')
        .option('--seo-description <text>', 'SEO description.')
        .option('--seo-slug <slug>', 'SEO slug.')
        .option('--image <path>', 'Local image file to upload as the product image (png, jpg, gif, webp, svg). Uploaded to the CDN by the server.')
        .option('--file <path>', 'JSON payload file ("-" for stdin). Flags override its fields. May carry `bonuses` and `bonus_rule` (see `ef products bonuses --help`).');
}

function payloadFromOpts(opts: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [flag, key] of Object.entries(STRING_FIELDS)) {
        if (opts[flag] !== undefined) out[key] = opts[flag];
    }
    for (const [flag, key] of Object.entries(NUMBER_FIELDS)) {
        if (opts[flag] !== undefined) out[key] = opts[flag];
    }
    return out;
}

async function buildPayload(opts: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = opts.file ? await readJsonPayloadFile(opts.file as string) : {};
    return { ...base, ...payloadFromOpts(opts) };
}

export function registerProductsCommand(program: Command): void {
    const cmd = program
        .command('products')
        .description('Product actions: list, get, create, update, delete, clone, bonuses, bonus-rule.');

    cmd.command('list')
        .alias('ls')
        .description('List products.')
        .option('--classification <c>', 'Filter by classification (main, upsell, …).')
        .option('--limit <n>', 'Limit rows shown (default: all).', (v) => parseInt(v, 10))
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { classification?: string; limit?: number; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const products = await api.listProducts(rt.config.brandId, opts.classification ? { classification: opts.classification } : undefined);
            const rows = opts.limit ? products.slice(0, opts.limit) : products;
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'code', 'title', 'class', 'price', 'bonuses', 'updated'],
                rows: rows.map(p => [
                    String(p.id),
                    p.code ?? '',
                    p.title ?? '',
                    p.classification ?? '',
                    p.price != null ? String(p.price) : '',
                    bonusSummary(p),
                    formatRelative(p.updated_at),
                ]),
            }) + '\n');
            log.detail(`${rows.length} products`);
        });

    cmd.command('get <idOrCode>')
        .description('Print one product as JSON (includes `bonuses` and `bonus_rule`).')
        .action(async (ref: string) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const product = await resolveProduct(api, rt.config.brandId, ref);
            log.json(product);
            if (Array.isArray(product.bonuses) && product.bonuses.length) {
                log.detail(`bonuses: ${describeRule(product.bonus_rule, product.bonuses.length)}`);
            }
        });

    addCommonFlags(
        cmd.command('create')
            .description('Create a product. Requires --title and --code (or a --file that supplies them).'),
    )
        .option('--json', 'Print result as JSON.')
        .action(async (opts: Record<string, unknown>) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const payload = await buildPayload(opts);
            if (!payload.title) throw new CliError(ExitCode.Validation, 'A product title is required (pass --title or include it in --file).');
            if (!payload.code) throw new CliError(ExitCode.Validation, 'A product code is required (pass --code or include it in --file).');
            const image = opts.image ? await readImageUpload(opts.image as string) : undefined;
            const created = await api.createProduct(rt.config.brandId, payload, image);
            if (opts.json) { log.json({ ok: true, product: created }); return; }
            log.success(`Created product #${created.id} "${created.code ?? payload.code}" (${created.title ?? payload.title}).${image ? ' Image uploaded.' : ''}`);
        });

    addCommonFlags(
        cmd.command('update <id>')
            .description('Update a product. Only the fields you pass (flags and/or --file) are changed.'),
    )
        .option('--json', 'Print result as JSON.')
        .action(async (id: string, opts: Record<string, unknown>) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const pid = numericId(id);
            const payload = await buildPayload(opts);
            const image = opts.image ? await readImageUpload(opts.image as string) : undefined;
            if (Object.keys(payload).length === 0 && !image) {
                throw new CliError(ExitCode.Validation, 'Nothing to update — pass at least one field flag, --image, or --file.');
            }
            // The server requires `title` on every update (it's not a partial
            // PATCH). Backfill it from the current product when the caller didn't
            // supply one, so updating just one field (or only the image) works.
            if (payload.title === undefined) {
                const current = await api.getProduct(rt.config.brandId, pid);
                if (current.title) payload.title = current.title;
            }
            const updated = await api.updateProduct(rt.config.brandId, pid, payload, image);
            if (opts.json) { log.json({ ok: true, product: updated }); return; }
            log.success(`Updated product #${updated.id ?? id}.${image ? ' Image uploaded.' : ''}`);
        });

    cmd.command('delete <id>')
        .description('Delete a product.')
        .option('--force', 'Do not require confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (id: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const pid = numericId(id);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete product #${pid}?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deleteProduct(rt.config.brandId, pid);
            if (opts.json) { log.json({ ok: true, deleted: pid }); return; }
            log.success(`Deleted product #${pid}.`);
        });

    cmd.command('clone <id>')
        .description('Clone a product on the server.')
        .option('--json', 'Print result as JSON.')
        .action(async (id: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const clone = await api.cloneProduct(rt.config.brandId, numericId(id));
            if (opts.json) { log.json({ ok: true, product: clone }); return; }
            log.success(`Cloned product #${id} → #${clone.id} (${clone.code ?? '?'}).`);
        });

const BONUS_HELP = `
A bonus is a FREE product attached to a main product (or package). The rule
(\`ef products bonus-rule\`) says how many the buyer picks: exactly N, up to N,
or all. Nothing picked ⇒ the first N by position (or all). Bonuses marked
giftable can be sent "to a friend": a separate linked gift order.

Bonuses are not bumps. Bonus products need classification "bonus".

Examples:
  ef products bonuses HERPAFEND_MAIN_2B_P158
  ef products bonuses 812 --add SNOOZE_MAX:giftable --add BIOME_SHIELD:giftable --add MORINGA:giftable
  ef products bonuses 812 --order MORINGA,SNOOZE_MAX,BIOME_SHIELD
  ef products bonuses 812 --remove MORINGA
  ef products bonuses 812 --not-giftable SNOOZE_MAX
  ef products bonuses 812 --clear
`;

const RULE_HELP = `
Pick modes (one of):
  --pick <n>     buyer picks exactly n        (min = max = n)
  --up-to <n>    buyer picks 1..n             (min 1, max n; --min to change)
  --all          every bonus included, no picking

Nothing picked ⇒ --default first_n (first n by position) or all. A pick the
rule does not allow is rejected by the checkout with a 422, never "fixed".

Gift ("send to a friend"): --gift on lets the buyer ship the GIFTABLE bonuses to
another address. That creates a separate gift order (own order id) linked to the
main one. The friend's email is optional and is never used to notify them.
Gift shipping is charged on the main order:
  same_as_main (default) · free · fixed (needs --gift-price)

Without a rule, the internal checkout does not activate a product's bonuses
(unless a page/funnel override sets them). For a seasonal offer that must not
change the normal checkout, use checkout_settings.bonuses in the page's backend
script, or the set_checkout_bonuses funnel node, instead of a product rule.

Examples:
  ef products bonus-rule HERPAFEND_MAIN_2B_P158 --pick 1
  ef products bonus-rule HERPAFEND_HWN_3B_P170 --up-to 2 --gift on
  ef products bonus-rule HERPAFEND_MAIN_6B_P294 --all --gift on --gift-shipping free
  ef products bonus-rule 812 --gift-shipping fixed --gift-price 4.99
  ef products bonus-rule 812 --clear
`;

    cmd.command('bonuses <idOrCode>')
        .description('Show or edit a product\'s bonuses (free products the buyer gets or picks). No edit flags = show.')
        .option('--add <CODE[:qty][:giftable]>', 'Attach a bonus by product code (repeatable, or comma-separated). An existing code is updated in place.', collect, [])
        .option('--remove <codes>', 'Detach bonuses by code (repeatable or comma-separated).', collect, [])
        .option('--order <codes>', 'Comma-separated codes in the order they are offered (position). Unlisted bonuses keep their order after these.')
        .option('--giftable <codes>', 'Mark bonuses giftable (may be sent to a friend).', collect, [])
        .option('--not-giftable <codes>', 'Mark bonuses not giftable (always ship to the buyer).', collect, [])
        .option('--clear', 'Remove every bonus (runs before --add, so --clear --add X replaces the list).')
        .option('--json', 'Print { product, bonuses, bonus_rule } as JSON.')
        .addHelpText('after', BONUS_HELP)
        .action(async (ref: string, opts: { add: string[]; remove: string[]; order?: string; giftable: string[]; notGiftable: string[]; clear?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            let product = await resolveProduct(api, rt.config.brandId, ref);
            const current = normalizeBonuses(product.bonuses);
            const edits = {
                clear: !!opts.clear,
                add: splitList(opts.add).map(parseBonusSpec),
                remove: splitList(opts.remove),
                order: splitList(opts.order),
                giftable: splitList(opts.giftable),
                notGiftable: splitList(opts.notGiftable),
            };
            const editing = edits.clear || edits.add.length || edits.remove.length || edits.order.length || edits.giftable.length || edits.notGiftable.length;
            if (editing) {
                const next = applyBonusEdits(current, edits);
                const rule = product.bonus_rule;
                if (rule && rule.max_picks != null && rule.max_picks > next.length) {
                    throw new CliError(ExitCode.Validation,
                        `The bonus rule lets the buyer pick ${rule.max_picks}, but only ${next.length} bonus${next.length === 1 ? '' : 'es'} would remain. Change the rule first (ef products bonus-rule ${ref} --pick <n> | --all | --clear).`);
                }
                const payload: Record<string, unknown> = { bonuses: toBonusPayload(next) };
                if (product.title) payload.title = product.title; // the update endpoint requires a title
                product = await api.updateProduct(rt.config.brandId, product.id, payload);
                if (!Array.isArray(product.bonuses)) product.bonuses = next.map(b => ({ ...b }));
                if (rule && next.length && !next.some(b => b.giftable) && rule.gift_shipping_enabled) {
                    log.warn('Gift shipping is on, but no bonus is giftable now, so "send to a friend" will not show.');
                }
            }
            const list = normalizeBonuses(product.bonuses);
            if (opts.json) { log.json({ ok: true, product: { id: product.id, code: product.code, title: product.title }, bonuses: product.bonuses ?? [], bonus_rule: product.bonus_rule ?? null }); return; }
            if (editing) log.success(`Saved ${list.length} bonus${list.length === 1 ? '' : 'es'} on #${product.id} ${product.code ?? ''}.`);
            printBonuses(product, list);
        });

    cmd.command('bonus-rule <idOrCode>')
        .description('Show or set how many bonuses the buyer picks, the default when nothing is picked, and gift ("send to a friend") shipping. No flags = show.')
        .option('--pick <n>', 'Buyer picks exactly n bonuses.', parseNum)
        .option('--up-to <n>', 'Buyer picks up to n bonuses.', parseNum)
        .option('--all', 'Every bonus included; no picking.')
        .option('--min <n>', 'Override the minimum number of picks.', parseNum)
        .option('--default <mode>', 'When nothing is picked: first_n | all.')
        .option('--gift <on|off>', 'Allow sending the giftable bonuses to a friend\'s address (separate gift order).')
        .option('--gift-shipping <mode>', 'Gift shipping price, charged on the main order: same_as_main | free | fixed.')
        .option('--gift-price <amount>', 'Price for --gift-shipping fixed (implies fixed).', parseNum)
        .option('--clear', 'Delete the rule (legacy: all bonuses, no picking, not active on the internal checkout).')
        .option('--json', 'Print { product, bonuses, bonus_rule } as JSON.')
        .addHelpText('after', RULE_HELP)
        .action(async (ref: string, opts: { pick?: number; upTo?: number; all?: boolean; min?: number; default?: string; gift?: string; giftShipping?: string; giftPrice?: number; clear?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            let product = await resolveProduct(api, rt.config.brandId, ref);
            const list = normalizeBonuses(product.bonuses);
            const setting = opts.pick != null || opts.upTo != null || !!opts.all || opts.min != null || opts.default != null
                || opts.gift != null || opts.giftShipping != null || opts.giftPrice != null;
            if (opts.clear && setting) throw new CliError(ExitCode.Validation, '--clear cannot be combined with other rule flags.');
            if (opts.clear || setting) {
                let payload: Record<string, unknown>;
                if (opts.clear) {
                    payload = { bonus_rule: null };
                } else {
                    const { rule, warnings } = buildRule(product.bonus_rule, opts, list.length, list.filter(b => b.giftable).length);
                    for (const w of warnings) log.warn(w);
                    payload = { bonus_rule: rule };
                }
                if (product.title) payload.title = product.title;
                const updated = await api.updateProduct(rt.config.brandId, product.id, payload);
                if (updated.bonus_rule === undefined) updated.bonus_rule = (payload.bonus_rule as Product['bonus_rule']);
                if (!Array.isArray(updated.bonuses)) updated.bonuses = product.bonuses;
                product = updated;
            }
            if (opts.json) { log.json({ ok: true, product: { id: product.id, code: product.code, title: product.title }, bonuses: product.bonuses ?? [], bonus_rule: product.bonus_rule ?? null }); return; }
            if (opts.clear) log.success(`Deleted the bonus rule on #${product.id} ${product.code ?? ''}.`);
            else if (setting) log.success(`Saved the bonus rule on #${product.id} ${product.code ?? ''}.`);
            printBonuses(product, normalizeBonuses(product.bonuses));
        });
}

function printBonuses(product: Product, list: ReturnType<typeof normalizeBonuses>): void {
    log.info(`#${product.id} ${product.code ?? ''} ${product.title ? `(${product.title})` : ''}`.trim());
    if (!list.length) {
        log.detail('No bonuses. Attach one: ef products bonuses <product> --add CODE[:qty][:giftable]');
    } else {
        log.raw(renderTable({
            head: ['pos', 'code', 'title', 'qty', 'giftable'],
            rows: list.map((b, i) => [String(i + 1), b.code ?? (b.product_id != null ? `#${b.product_id}` : ''), b.title ?? '', String(b.quantity), b.giftable ? 'yes' : '']),
        }) + '\n');
    }
    log.info(`rule: ${describeRule(product.bonus_rule, list.length)}`);
}

function collect(value: string, previous: string[]): string[] {
    return [...(previous ?? []), value];
}

/**
 * Resolve a product by numeric id or by code. Codes are looked up in the
 * brand's product list (case-insensitive), then fetched by id so the result
 * carries the full record, bonuses included.
 */
export async function resolveProduct(api: ApiClient, brandId: number, ref: string): Promise<Product> {
    const trimmed = String(ref).trim();
    if (/^\d+$/.test(trimmed)) return api.getProduct(brandId, parseInt(trimmed, 10));
    const products = await api.listProducts(brandId);
    const hit = products.find(p => (p.code ?? '').toLowerCase() === trimmed.toLowerCase());
    if (!hit) throw new CliError(ExitCode.NotFound, `No product with code "${trimmed}" in this brand. List them with: ef products list`);
    return api.getProduct(brandId, hit.id);
}


function parseNum(v: string): number {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new CliError(ExitCode.Validation, `Expected a number, got "${v}".`);
    return n;
}

function numericId(id: string): number {
    if (!/^\d+$/.test(id)) throw new CliError(ExitCode.Validation, `Expected a numeric product id, got "${id}".`);
    return parseInt(id, 10);
}
