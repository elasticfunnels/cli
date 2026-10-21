import * as crypto from 'crypto';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { KitContextApi, type KitContextBundle, type KitImage } from '../api/kitContextApi';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';

export interface GenerateRequest {
    kitId: number;
    slot: string;
    prompt: string;
    aspect?: string;
    referenceIds: number[];
}

/**
 * What to send for `ef images generate`, from the pulled context and the flags. The kit image
 * endpoint prices and fills a kit SLOT, so a slot is required; --prompt replaces the slot's
 * prompt and --product adds the product's name and its packshot/label images as references.
 */
export function buildGenerateRequest(b: KitContextBundle, opts: { slot?: string; prompt?: string; product?: string; aspect?: string; reference?: string[] }): GenerateRequest {
    const ctx = b.context;
    const kitId = Number(ctx?.kit?.id ?? ctx?.builder_resource_id ?? 0);
    if (!ctx || !kitId) throw new CliError(ExitCode.Validation, 'This brand has no applied kit, so there is no kit image slot to fill. Apply a kit first.');
    if (!opts.slot) {
        const names = b.slots.map((s) => s.slot).slice(0, 20).join(', ');
        throw new CliError(ExitCode.Validation, `Pass --slot: kit images are generated into one of the kit's slots${names ? ` (${names})` : ''}. --prompt replaces that slot's prompt.`);
    }
    const slot = b.slots.find((s) => s.slot === opts.slot);
    if (!slot && !opts.prompt) throw new CliError(ExitCode.NotFound, `The kit has no image slot "${opts.slot}". Run ef context pull and see slots.json.`);
    let prompt = (opts.prompt ?? slot?.prompt ?? '').trim();
    if (prompt.length < 3) throw new CliError(ExitCode.Validation, `Slot "${opts.slot}" has no prompt; pass --prompt "...".`);

    const refs = new Set<number>();
    for (const r of opts.reference ?? []) {
        for (const part of String(r).split(',')) {
            const n = Number(part.trim());
            if (!Number.isInteger(n) || n <= 0) throw new CliError(ExitCode.Validation, `--reference takes asset ids (numbers); got "${part}".`);
            refs.add(n);
        }
    }
    if (opts.product) {
        const code = opts.product;
        const product = (ctx.kit?.products ?? []).find((p) => p.code === code || p.old_code === code);
        if (!product && !b.assets.some((a) => a.product_code === code)) {
            throw new CliError(ExitCode.NotFound, `No product "${code}" in this kit's context. Products: ${(ctx.kit?.products ?? []).map((p) => p.code).join(', ') || 'none'}.`);
        }
        if (product?.name) prompt = `${prompt}\n\nThe product is "${product.name}" (code ${product.code}); show it as it looks in the reference images.`;
        if (!(opts.reference ?? []).length) {
            for (const a of b.assets) {
                if (a.product_code === (product?.code ?? code) && (a.role === 'packshot' || a.role === 'label')) refs.add(a.id);
            }
        }
    }
    return { kitId, slot: opts.slot, prompt: prompt.slice(0, 6000), aspect: opts.aspect ?? slot?.aspect ?? undefined, referenceIds: [...refs].slice(0, 6) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `--max-credits`: a non-negative whole number, or the command refuses (a NaN cap used to skip the check). */
export function parseMaxCredits(v: string): number {
    const t = String(v).trim();
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!Number.isSafeInteger(n)) throw new CliError(ExitCode.Validation, `--max-credits takes a whole number of credits, got ${JSON.stringify(v)}.`);
    return n;
}

export function registerImagesCommand(program: Command): void {
    const cmd = program.command('images').description('AI images for the kit\'s image slots, paid in AI credits.');
    cmd.command('generate')
        .description('Generate one image into a kit slot. Shows the credit cost first; asks to confirm unless --yes.')
        .option('--slot <slot>', 'Kit image slot to fill (see .ef/context/slots.json).')
        .option('--prompt <text>', 'Prompt to use instead of the slot\'s own.')
        .option('--product <code>', 'Product the image shows: adds its name and its packshot/label images as references.')
        .option('--aspect <w:h>', 'Aspect ratio, e.g. 4:5 (default: the slot\'s).')
        .option('--reference <assetId...>', 'Asset ids to use as reference images (repeat or comma-separate).')
        .option('--max-credits <n>', 'Refuse if one image costs more than this (a job\'s credit cap).', parseMaxCredits)
        .option('-y, --yes', 'Do not ask to confirm the cost (needed in non-interactive runs).')
        .option('--no-wait', 'Return as soon as the image is queued.')
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: { slot?: string; prompt?: string; product?: string; aspect?: string; reference?: string[]; maxCredits?: number; yes?: boolean; wait?: boolean; json?: boolean }) => {
            if (opts.aspect && !/^\d{1,2}:\d{1,2}$/.test(opts.aspect)) throw new CliError(ExitCode.Validation, '--aspect looks like 4:5.');
            const rt = await loadRuntime();
            const ctxApi = new KitContextApi(new ApiClient(rt.config.apiUrl, rt.apiKey, rt.auth), rt.config.brandId);
            const req = buildGenerateRequest(await ctxApi.get(), opts);

            const est = await ctxApi.imageEstimate(1);
            const cost = est.credits_per_image;
            if (!opts.json) log.info(`One image into "${req.slot}" costs ${cost} AI credits (balance ${est.balance}, after ${est.balance_after}).`);
            if (opts.maxCredits !== undefined && !(typeof cost === 'number' && Number.isFinite(cost))) {
                throw new CliError(ExitCode.Error, 'The server did not return a price for this image, so the --max-credits cap cannot be checked. Not generated.');
            }
            if (opts.maxCredits !== undefined && cost > opts.maxCredits) {
                throw new CliError(ExitCode.Validation, `This image costs ${cost} credits, over the cap of ${opts.maxCredits}. Not generated.`);
            }
            if (!est.can_afford) throw new CliError(ExitCode.Validation, `Not enough AI credits: ${cost} needed, ${est.balance} available.`);
            if (!opts.yes) {
                if (!process.stdin.isTTY) throw new CliError(ExitCode.Validation, `This costs ${cost} AI credits. Re-run with --yes to confirm.`);
                const { confirm } = await import('../utils/prompt');
                if (!(await confirm(`Spend ${cost} AI credits on this image?`, false))) throw new CliError(ExitCode.Validation, 'Aborted.');
            }

            // max_credits goes along so the server can refuse a price that moved after the
            // estimate; until the app enforces it, the check above is the cap.
            let image: KitImage = await ctxApi.generateImage({ ...req, idempotencyKey: crypto.randomBytes(16).toString('hex'), ...(opts.maxCredits !== undefined ? { maxCredits: opts.maxCredits } : {}) });
            if (opts.wait !== false) {
                const until = Date.now() + Number(process.env.EF_IMAGE_WAIT_MS ?? 5 * 60_000);
                const every = Number(process.env.EF_IMAGE_POLL_MS ?? 3000);
                while (image.status !== 'done' && image.status !== 'failed' && Date.now() < until) {
                    await sleep(every);
                    image = await ctxApi.getImage(image.id);
                }
            }
            if (opts.json) {
                log.json({ ok: image.status !== 'failed', credits: cost, image });
            } else if (image.status === 'done') {
                log.success(`Image #${image.id} for "${image.slot}": ${image.url}`);
            } else if (image.status === 'failed') {
                log.error(`Image #${image.id} failed (${image.error ?? 'generation_failed'}); credits ${image.refunded ? 'refunded' : 'will be refunded'}.`);
            } else {
                log.info(`Image #${image.id} is ${image.status}. Check later with ef context pull (slots.json).`);
            }
            if (image.status === 'failed') process.exitCode = ExitCode.Error;
        });
}
