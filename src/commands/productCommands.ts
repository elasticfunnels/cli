import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient, ProductImageUpload } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { readJsonPayloadFile } from './shared';
import { formatRelative, renderTable } from '../utils/format';

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
        .option('--file <path>', 'JSON payload file ("-" for stdin). Flags override its fields.');
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
        .description('Product actions: list, get, create, update, delete, clone.');

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
                head: ['#', 'code', 'title', 'class', 'price', 'updated'],
                rows: rows.map(p => [
                    String(p.id),
                    p.code ?? '',
                    p.title ?? '',
                    p.classification ?? '',
                    p.price != null ? String(p.price) : '',
                    formatRelative(p.updated_at),
                ]),
            }) + '\n');
            log.detail(`${rows.length} products`);
        });

    cmd.command('get <id>')
        .description('Print one product as JSON.')
        .action(async (id: string) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const product = await api.getProduct(rt.config.brandId, numericId(id));
            log.json(product);
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
