import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Funnel } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { EfRuntime, loadRuntime } from '../utils/store';
import { sha256, writeFileAtomic } from '../utils/fs';
import { readSnapshot, writeSnapshot } from '../sync/baselineSnapshots';
import { canonical, graphHash } from '../sync/graph';
import { unifiedDiff } from '../sync/merge';
import { safeJoinBrandRoot } from '../sync/paths';
import { formatRelative, renderTable } from '../utils/format';

/** Starter graph written when a funnel has no builder graph yet. */
const EMPTY_GRAPH = { drawflow: { Home: { data: {} } } };

function sanitizeCode(code: string): string { return code.replace(/[^a-zA-Z0-9._-]+/g, '-'); }
function relForFunnel(code: string): string { return `funnels/${sanitizeCode(code)}.flow.json`; }

async function resolveFunnel(api: ApiClient, brandId: number, codeOrId: string): Promise<Funnel> {
    const list = await api.listFunnels(brandId);
    const hit = list.find((f) => f.code === codeOrId || String(f.id) === codeOrId);
    if (!hit) throw new CliError(ExitCode.NotFound, `No funnel with code/id "${codeOrId}". Run "ef funnels list".`);
    return hit;
}

async function writeFunnelFile(rt: EfRuntime, code: string, graph: unknown): Promise<string> {
    const rel = relForFunnel(code);
    const abs = safeJoinBrandRoot(rt.brandRoot, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, JSON.stringify(graph, null, 2) + '\n');
    return rel;
}

export async function pullFunnelBuilder(rt: EfRuntime, api: ApiClient, funnel: Funnel, opts: { skeleton?: boolean } = {}): Promise<{ rel: string; empty: boolean } | null> {
    const graph = await api.getFunnelBuilder(rt.config.brandId, funnel.id);
    if (!graph && !opts.skeleton) return null;
    const finalGraph = graph ?? EMPTY_GRAPH;
    const rel = await writeFunnelFile(rt, funnel.code ?? String(funnel.id), finalGraph);
    await writeSnapshot(rt.brandRoot, 'funnel', funnel.id, Buffer.from(canonical(finalGraph), 'utf8'));
    return { rel, empty: !graph };
}

function readLocalFunnelGraph(rt: EfRuntime, code: string): { rel: string; graph: unknown } {
    const rel = relForFunnel(code);
    const abs = safeJoinBrandRoot(rt.brandRoot, rel);
    let raw: string;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch {
        throw new CliError(ExitCode.NotFound, `No funnel file at ${rel}. Run "ef funnels pull ${code}" first.`);
    }
    try { return { rel, graph: JSON.parse(raw) }; } catch (err) {
        throw new CliError(ExitCode.Validation, `${rel} is not valid JSON: ${(err as Error).message}`);
    }
}

export interface FunnelDiffEntry {
    rel: string;
    kind: 'funnel';
    serverId: number | null;
    status: 'clean' | 'dirty' | 'server-newer' | 'both-changed' | 'local-only' | 'unknown';
    note?: string;
    diff?: string;
}

/** Diff a `funnels/<code>.flow.json` file against the server graph (for `ef diff`). */
export async function funnelDiffEntry(rt: EfRuntime, api: ApiClient, abs: string): Promise<FunnelDiffEntry> {
    const rel = path.relative(rt.brandRoot, abs).split(path.sep).join('/');
    let local: unknown;
    try { local = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch {
        return { rel, kind: 'funnel', serverId: null, status: 'unknown', note: 'invalid JSON' };
    }
    const code = rel.replace(/^funnels\//, '').replace(/\.flow\.json$/i, '');
    let funnel: Funnel;
    try { funnel = await resolveFunnel(api, rt.config.brandId, code); } catch {
        return { rel, kind: 'funnel', serverId: null, status: 'local-only', note: `no funnel "${code}"` };
    }
    const server = (await api.getFunnelBuilder(rt.config.brandId, funnel.id)) ?? EMPTY_GRAPH;
    const localHash = graphHash(local);
    const serverHash = graphHash(server);
    const baseline = await readSnapshot(rt.brandRoot, 'funnel', funnel.id);
    const baseHash = baseline ? sha256(baseline) : null;
    let status: FunnelDiffEntry['status'];
    if (localHash === serverHash) status = 'clean';
    else if (baseHash == null) status = 'dirty';
    else {
        const localChanged = localHash !== baseHash;
        const serverChanged = serverHash !== baseHash;
        status = localChanged && serverChanged ? 'both-changed' : serverChanged ? 'server-newer' : 'dirty';
    }
    return {
        rel, kind: 'funnel', serverId: funnel.id, status,
        diff: status === 'clean' ? undefined : unifiedDiff(JSON.stringify(server, null, 2) + '\n', JSON.stringify(local, null, 2) + '\n', 'server', 'local'),
    };
}

async function ctx(): Promise<{ rt: EfRuntime; api: ApiClient; brandId: number }> {
    const rt = await loadRuntime();
    return { rt, api: new ApiClient(rt.config.apiUrl, rt.apiKey), brandId: rt.config.brandId };
}

export function registerFunnelsCommand(program: Command): void {
    const cmd = program
        .command('funnels')
        .description('Funnels: list, pull/push the builder graph (funnels/<code>.flow.json), diff, create, delete.');

    cmd.command('list')
        .alias('ls')
        .description('List funnels.')
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const rows = await api.listFunnels(brandId);
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'code', 'title', 'status', 'updated'],
                rows: rows.map((f) => [String(f.id), f.code ?? '', f.title ?? '', f.status ?? '', formatRelative(f.updated_at)]),
            }) + '\n');
            log.detail(`${rows.length} funnels`);
        });

    cmd.command('pull [codeOrId]')
        .description('Pull a funnel builder graph → funnels/<code>.flow.json. --all for every funnel that has one.')
        .option('--all', 'Pull every funnel\'s graph.')
        .option('--json', 'Print result as JSON.')
        .action(async (codeOrId: string | undefined, opts: { all?: boolean; json?: boolean }) => {
            const { rt, api, brandId } = await ctx();
            if (opts.all || !codeOrId) {
                const funnels = await api.listFunnels(brandId);
                const written: string[] = [];
                for (const f of funnels) { const r = await pullFunnelBuilder(rt, api, f).catch(() => null); if (r) written.push(r.rel); }
                if (opts.json) { log.json({ ok: true, pulled: written }); return; }
                for (const rel of written) log.info(`  ${c.green('pulled')} ${rel}`);
                log.success(`Pulled ${written.length} funnel graph(s) (funnels with none were skipped).`);
                return;
            }
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            const r = await pullFunnelBuilder(rt, api, funnel, { skeleton: true });
            if (opts.json) { log.json({ ok: true, pulled: r?.rel, empty: r?.empty ?? true }); return; }
            log.success(r?.empty ? `Funnel has no graph yet — wrote a starter to ${r.rel}.` : `Pulled → ${r?.rel}.`);
        });

    cmd.command('push <codeOrId>')
        .description('Push funnels/<code>.flow.json (REFUSES if the server changed since you pulled).')
        .option('--force', 'Push even if the server\'s graph changed since you pulled (overwrites it).')
        .option('--json', 'Print result as JSON.')
        .action(async (codeOrId: string, opts: { force?: boolean; json?: boolean }) => {
            const { rt, api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            const code = funnel.code ?? String(funnel.id);
            const { rel, graph } = readLocalFunnelGraph(rt, code);

            if (!opts.force) {
                const baseline = await readSnapshot(rt.brandRoot, 'funnel', funnel.id);
                const server = await api.getFunnelBuilder(brandId, funnel.id);
                const serverHash = graphHash(server ?? EMPTY_GRAPH);
                const localHash = graphHash(graph);
                if (baseline) {
                    // We pulled before: refuse if the server moved off our baseline
                    // (and our local isn't already identical to what's on the server).
                    if (serverHash !== sha256(baseline) && serverHash !== localHash) {
                        const msg = `Changes rejected: funnel "${code}" changed on the server since you pulled. `
                            + `Run "ef diff funnels/${code}.flow.json" to see, then "ef funnels pull ${code} --force" to take the server's or "ef funnels push ${code} --force" to overwrite.`;
                        if (opts.json) log.json({ ok: false, conflict: true, rel, message: msg }); else log.error(msg);
                        process.exitCode = ExitCode.Conflict;
                        return;
                    }
                } else if (serverHash !== graphHash(EMPTY_GRAPH) && serverHash !== localHash) {
                    // Never pulled, but the server already has a builder graph: pushing now
                    // would clobber edits we've never seen. Force a pull first.
                    const msg = `Changes rejected: funnel "${code}" already has a builder graph on the server, but you never pulled it. `
                        + `Run "ef funnels pull ${code}" first (then re-apply your change), or "ef funnels push ${code} --force" to overwrite.`;
                    if (opts.json) log.json({ ok: false, conflict: true, rel, message: msg }); else log.error(msg);
                    process.exitCode = ExitCode.Conflict;
                    return;
                }
            }
            await api.setFunnelBuilder(brandId, funnel.id, graph);
            const normalized = await api.getFunnelBuilder(brandId, funnel.id).catch(() => null);
            if (normalized) await writeFunnelFile(rt, code, normalized);
            await writeSnapshot(rt.brandRoot, 'funnel', funnel.id, Buffer.from(canonical(normalized ?? graph), 'utf8'));
            if (opts.json) { log.json({ ok: true, pushed: rel, funnelId: funnel.id }); return; }
            log.success(`Pushed funnel graph "${code}" (#${funnel.id}). flow / product_flow / variant_seeds regenerated server-side.`);
        });

    cmd.command('diff <codeOrId>')
        .description('Show the difference between the local funnel graph and the server\'s (no merge — you decide which to keep).')
        .option('--json', 'Print { rel, status, diff } as JSON.')
        .action(async (codeOrId: string, opts: { json?: boolean }) => {
            const { rt, api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            const abs = safeJoinBrandRoot(rt.brandRoot, relForFunnel(funnel.code ?? String(funnel.id)));
            const entry = await funnelDiffEntry(rt, api, abs);
            if (opts.json) { log.json(entry); return; }
            if (entry.status === 'clean') { log.success(`No difference — ${entry.rel} matches the server.`); return; }
            if (entry.diff) log.raw(entry.diff.endsWith('\n') ? entry.diff : entry.diff + '\n');
        });

    cmd.command('create <title>')
        .description('Create a funnel (the server assigns its code), then write its empty builder graph to disk. Requires at least one --domain.')
        .option('--status <status>', 'active | inactive | draft.')
        .option('--domain <id>', 'Domain id to attach (required by the server; see "ef domains list").', (v) => parseInt(v, 10))
        .option('--json', 'Print result as JSON.')
        .action(async (title: string, opts: { status?: string; domain?: number; json?: boolean }) => {
            const { rt, api, brandId } = await ctx();
            const payload: Record<string, unknown> = { title };
            if (opts.status) payload.status = opts.status;
            if (opts.domain != null) payload.domains = [{ domain_id: opts.domain, is_default: true }];
            const created = await api.createFunnel(brandId, payload);
            await pullFunnelBuilder(rt, api, created, { skeleton: true }).catch(() => null);
            if (opts.json) { log.json({ ok: true, funnel: created }); return; }
            log.success(`Created funnel #${created.id} (${created.code ?? title}).`);
        });

    cmd.command('delete <codeOrId>')
        .description('Delete a funnel (and its local file).')
        .option('--force', 'Do not require confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (codeOrId: string, opts: { force?: boolean; json?: boolean }) => {
            const { rt, api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                if (!(await confirm(`Delete funnel #${funnel.id} "${funnel.code ?? funnel.title}"?`, false))) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deleteFunnel(brandId, funnel.id);
            const rel = relForFunnel(funnel.code ?? String(funnel.id));
            let removed = false;
            try { await fs.promises.unlink(safeJoinBrandRoot(rt.brandRoot, rel)); removed = true; } catch { /* no local file */ }
            if (opts.json) { log.json({ ok: true, deleted: { id: funnel.id, code: funnel.code }, localFileRemoved: removed }); return; }
            log.success(`Deleted funnel #${funnel.id}.${removed ? ` Removed ${rel}.` : ''}`);
        });

    cmd.command('debug-flow <codeOrId>')
        .description('Print the compiled (read-only) execution flow tree as JSON.')
        .action(async (codeOrId: string) => {
            const { api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            log.json(await api.getFunnelDebugFlow(brandId, funnel.id));
        });

    cmd.command('product-flow <codeOrId>')
        .description('Print the compiled (read-only) product flow as JSON.')
        .action(async (codeOrId: string) => {
            const { api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            log.json(await api.getFunnelProductFlow(brandId, funnel.id));
        });
}
