import { Command } from 'commander';
import * as fs from 'fs/promises';
import { ApiClient } from '../api/client';
import { audiences } from '../api/campaignsApi';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatRelative, renderTable } from '../utils/format';

// `ef audiences`: saved SegQL segments. Write and check a definition (validate, count) before saving it;
// the ef-segql skill documents the grammar. Samples come back masked when your key lacks contacts.view_pii.

async function ctx(): Promise<{ api: ApiClient; brandId: number }> {
    const rt = await loadRuntime();
    return { api: new ApiClient(rt.config.apiUrl, rt.apiKey), brandId: rt.config.brandId };
}

export function numericId(v: string, what = 'audience'): number {
    if (!/^\d+$/.test(v)) throw new CliError(ExitCode.Validation, `Expected a numeric ${what} id, got "${v}".`);
    return parseInt(v, 10);
}

interface SegqlOpts { segql?: string; file?: string }

/** SegQL from --segql or --file (use --file - for stdin). */
async function readSegql(opts: SegqlOpts, required = true): Promise<string | undefined> {
    if (opts.segql != null && opts.file != null) throw new CliError(ExitCode.Validation, 'Pass either --segql or --file, not both.');
    let text: string | undefined;
    if (opts.segql != null) text = opts.segql;
    else if (opts.file === '-') text = await readStdin();
    else if (opts.file != null) {
        try { text = await fs.readFile(opts.file, 'utf8'); } catch (err) {
            throw new CliError(ExitCode.NotFound, `Cannot read ${opts.file}: ${(err as Error).message}`);
        }
    }
    text = text?.trim();
    if (!text && required) throw new CliError(ExitCode.Validation, 'A SegQL definition is required: --segql "<FROM ...>" or --file <path>.');
    return text || undefined;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

function segqlOptions(cmd: Command): Command {
    return cmd
        .option('--segql <text>', 'SegQL definition, e.g. \'FROM conversions WHERE HAS conversion(type = "purchase") WITHIN 30d IDENTIFY BY email\'.')
        .option('--file <path>', 'Read the SegQL definition from a file (- for stdin).');
}

async function confirmOrThrow(yes: boolean | undefined, prompt: string): Promise<void> {
    if (yes) return;
    if (!process.stdin.isTTY) throw new CliError(ExitCode.Validation, `${prompt} Pass --yes to confirm (no terminal to ask on).`);
    const { confirm } = await import('../utils/prompt');
    if (!(await confirm(prompt, false))) throw new CliError(ExitCode.Validation, 'Aborted.');
}

export function registerAudiencesCommand(program: Command): void {
    const aud = program.command('audiences').alias('segments')
        .description('Audience segments written in SegQL: list, validate, count, create, update, delete.');

    aud.command('list', { isDefault: true })
        .alias('ls')
        .description('List saved audiences.')
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const rows = await audiences.list(api, brandId);
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'name', 'identity', 'members', 'computed', 'error'],
                rows: rows.map((s: any) => [
                    String(s.id), s.name ?? '', s.identity_kind ?? '', s.member_count == null ? '' : String(s.member_count),
                    s.computed_at ? formatRelative(s.computed_at) : '', s.error ? String(s.error).slice(0, 40) : '',
                ]),
            }) + '\n');
            log.detail(`${rows.length} audiences`);
        });

    aud.command('get <id>')
        .description('Print one audience (definition, size, last refresh) as JSON.')
        .action(async (id: string) => {
            const { api, brandId } = await ctx();
            log.json(await audiences.get(api, brandId, numericId(id)));
        });

    segqlOptions(aud.command('validate'))
        .description('Check a SegQL definition (parse + validate + compile) without running it.')
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: SegqlOpts & { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const res = await audiences.validate(api, brandId, (await readSegql(opts))!);
            if (opts.json) { log.json(res); return; }
            log.success(`Valid SegQL (identity: ${res.identity_column}).`);
        });

    segqlOptions(aud.command('count [id]').alias('preview'))
        .description('Size of an audience plus a sample: a saved one by id, or an unsaved --segql/--file definition.')
        .option('--sample <n>', 'How many sample identities / rows to return (0-200).', '10')
        .option('--members', 'Also return the member table (masked without contacts.view_pii).')
        .option('--json', 'Print the full response as JSON.')
        .action(async (id: string | undefined, opts: SegqlOpts & { sample: string; members?: boolean; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const sample = Math.max(0, Math.min(200, parseInt(opts.sample, 10) || 0));
            if (id != null) {
                if (opts.segql != null || opts.file != null) throw new CliError(ExitCode.Validation, 'Pass an audience id or a definition, not both.');
                const segId = numericId(id);
                const seg = await audiences.get(api, brandId, segId);
                const members = opts.members || sample > 0 ? await audiences.members(api, brandId, segId, { per_page: Math.max(1, sample) }) : null;
                if (opts.json) { log.json({ id: segId, count: seg.member_count ?? null, computed_at: seg.computed_at ?? null, members }); return; }
                log.success(`${seg.name}: ${seg.member_count ?? 'not computed yet'} people${seg.computed_at ? ` (refreshed ${formatRelative(seg.computed_at)})` : ''}.`);
                printRows((members as any)?.rows ?? []);
                return;
            }
            const segql = (await readSegql(opts))!;
            const res: any = await audiences.preview(api, brandId, segql, sample, !!opts.members);
            if (opts.json) { log.json(res); return; }
            log.success(`${res.count} people match (identity: ${res.identity_column}).`);
            if (Array.isArray(res.enriched_rows) && res.enriched_rows.length) printRows(res.enriched_rows);
            else if (Array.isArray(res.samples) && res.samples.length) log.detail(`sample: ${res.samples.slice(0, sample).join(', ')}`);
            if (res.members?.rows?.length) printRows(res.members.rows);
        });

    segqlOptions(aud.command('create'))
        .description('Save a SegQL definition as an audience (validated server-side, then computed).')
        .requiredOption('--name <name>', 'Audience name.')
        .option('--description <text>', 'Description.')
        .option('--color <hex>', 'Colour, e.g. #22c55e.')
        .option('--json', 'Print the created audience as JSON.')
        .action(async (opts: SegqlOpts & { name: string; description?: string; color?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const segql = (await readSegql(opts))!;
            const data: Record<string, unknown> = { name: opts.name, segql };
            if (opts.description != null) data.description = opts.description;
            if (opts.color != null) data.color = opts.color;
            const res: any = await audiences.create(api, brandId, data);
            if (opts.json) { log.json(res); return; }
            log.success(`Created audience #${res.id} "${res.name}". Run "ef audiences count ${res.id}" once it has computed.`);
        });

    segqlOptions(aud.command('update <id>'))
        .description('Rename an audience or replace its SegQL definition (which recomputes it).')
        .option('--name <name>', 'New name.')
        .option('--description <text>', 'New description.')
        .option('--color <hex>', 'New colour.')
        .option('--json', 'Print the updated audience as JSON.')
        .action(async (id: string, opts: SegqlOpts & { name?: string; description?: string; color?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const segId = numericId(id);
            const segql = await readSegql(opts, false);
            const meta: Record<string, unknown> = {};
            if (opts.name != null) meta.name = opts.name;
            if (opts.description != null) meta.description = opts.description;
            if (opts.color != null) meta.color = opts.color;
            if (!segql && !Object.keys(meta).length) throw new CliError(ExitCode.Validation, 'Nothing to update: pass --segql/--file, --name, --description or --color.');
            const res = segql
                ? await audiences.updateSegql(api, brandId, segId, { segql, ...meta })
                : await audiences.update(api, brandId, segId, meta);
            if (opts.json) { log.json(res); return; }
            log.success(`Updated audience #${segId}${segql ? ' (definition replaced; it recomputes now)' : ''}.`);
        });

    aud.command('delete <id>')
        .alias('rm')
        .description('Delete an audience.')
        .option('-y, --yes', 'Do not ask for confirmation.')
        .action(async (id: string, opts: { yes?: boolean }) => {
            const { api, brandId } = await ctx();
            const segId = numericId(id);
            await confirmOrThrow(opts.yes, `Delete audience #${segId}?`);
            await audiences.remove(api, brandId, segId);
            log.success(`Deleted audience #${segId}.`);
        });

    aud.command('members <id>')
        .description('The people in a saved audience (masked without contacts.view_pii).')
        .option('--page <n>', 'Page number.', '1')
        .option('--per-page <n>', 'Rows per page.', '50')
        .option('--q <text>', 'Search.')
        .option('--json', 'Print the full response as JSON.')
        .action(async (id: string, opts: { page: string; perPage: string; q?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const params: Record<string, unknown> = { page: parseInt(opts.page, 10) || 1, per_page: parseInt(opts.perPage, 10) || 50 };
            if (opts.q) params.q = opts.q;
            const res: any = await audiences.members(api, brandId, numericId(id), params);
            if (opts.json) { log.json(res); return; }
            printRows(res?.rows ?? []);
            if (res?.total != null) log.detail(`${res.total} people`);
        });

    aud.command('recompute <id>')
        .alias('refresh')
        .description('Recompute an audience now.')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const res = await audiences.recompute(api, brandId, numericId(id));
            if (opts.json) { log.json(res); return; }
            log.success(`Recompute queued for audience #${id}.`);
        });

    aud.command('schema')
        .description('The SegQL language contract from the server: sources, fields, profile fields, functions (JSON).')
        .action(async () => {
            const { api, brandId } = await ctx();
            log.json(await audiences.schema(api, brandId));
        });
}

/** A compact table of whatever scalar columns the rows carry. */
export function printRows(rows: Array<Record<string, unknown>>): void {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]).filter((k) => rows.some((r) => r[k] != null && typeof r[k] !== 'object')).slice(0, 8);
    log.raw(renderTable({ head: cols, rows: rows.map((r) => cols.map((k) => (r[k] == null ? '' : String(r[k]).slice(0, 40)))) }) + '\n');
}
