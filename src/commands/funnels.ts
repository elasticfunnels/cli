import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Funnel, FunnelDetails } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { EfRuntime, loadRuntime } from '../utils/store';
import { sha256, writeFileAtomic } from '../utils/fs';
import { readSnapshot, writeSnapshot } from '../sync/baselineSnapshots';
import { canonical, graphHash } from '../sync/graph';
import { unifiedDiff } from '../sync/merge';
import { safeJoinBrandRoot } from '../sync/paths';
import { formatRelative, renderTable } from '../utils/format';
import { resolveAnyPageId } from './pageGet';

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

/**
 * The body for `PUT funnels/{id}` that changes ONLY `changes`.
 *
 * FunnelsController::update is not a partial update: SaveFunnel always requires
 * `title`; `domains` is required unless the status SENT is `draft`, and when
 * present it replaces every assignment (delete + re-create, so the ClickBank /
 * Digistore24 / JVZoo ids must travel with each one); and `rules` is written
 * as null whenever it is absent. So everything is resent from the current
 * funnel. `trigger_pages` is left out on purpose — absent, the controller never
 * touches the builder graph; present, it rewrites the graph's page_group node.
 * `merchant_id` is validated but not fillable on BrandFunnel, so it is not sent.
 */
export function buildFunnelUpdatePayload(current: FunnelDetails, changes: { checkout_page_id?: number | null }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        title: current.title ?? '',
        status: current.status ?? 'active',
        rules: current.rules ?? null,
        domains: (current.domains ?? []).map((d) => ({
            domain_id: d.domain_id,
            is_default: Boolean(d.is_default),
            cb_funnel_id: d.cb_funnel_id ?? null,
            cb_template_code: d.cb_template_code ?? null,
            ds24_template_id: d.ds24_template_id ?? null,
            jvz_funnel_id: d.jvz_funnel_id ?? null,
        })),
        checkout_page_id: current.checkout_page_id ?? null,
    };
    if (changes.checkout_page_id !== undefined) payload.checkout_page_id = changes.checkout_page_id;
    return payload;
}

/** "slug (#id)" for a checkout page id, or null when unset; never throws. */
async function describeCheckoutPage(api: ApiClient, brandId: number, pageId: number | null | undefined): Promise<{ id: number; slug: string | null; title: string | null; isCheckoutPage: boolean | null } | null> {
    if (!pageId) return null;
    const page = await api.getPageDetails(brandId, pageId).catch(() => null);
    return {
        id: pageId,
        slug: (page?.slug ?? page?.variant_slug ?? null) as string | null,
        title: (page?.title ?? null) as string | null,
        isCheckoutPage: page ? Boolean((page as Record<string, unknown>).is_checkout_page) : null,
    };
}

async function ctx(): Promise<{ rt: EfRuntime; api: ApiClient; brandId: number }> {
    const rt = await loadRuntime();
    return { rt, api: new ApiClient(rt.config.apiUrl, rt.apiKey), brandId: rt.config.brandId };
}

export function registerFunnelsCommand(program: Command): void {
    const cmd = program
        .command('funnels')
        .description('Funnels: list, get, settings (checkout page), pull/push the builder graph (funnels/<code>.flow.json), diff, create, delete.');

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
            log.detail(`${rows.length} funnels. "ef funnels get <code>" shows one funnel's status, domains and checkout page.`);
        });

    cmd.command('get <codeOrId>')
        .alias('show')
        .description('Show one funnel\'s settings: status, domains, trigger pages and its checkout page.')
        .option('--json', 'Print as JSON.')
        .addHelpText('after', `
Examples:
  $ ef funnels get main-funnel
  $ ef funnels get 12 --json`)
        .action(async (codeOrId: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            const details = await api.getFunnel(brandId, funnel.id);
            const checkout = await describeCheckoutPage(api, brandId, details.checkout_page_id);
            const domains = (details.domains ?? []).map((d) => ({ domain_id: d.domain_id, is_default: Boolean(d.is_default) }));
            if (opts.json) {
                log.json({
                    ok: true,
                    funnel: {
                        id: details.id, code: details.code ?? null, title: details.title ?? null, status: details.status ?? null,
                        checkout_page_id: details.checkout_page_id ?? null, checkout_page: checkout,
                        domains, rules: details.rules ?? null, trigger_pages: details.trigger_pages ?? [],
                    },
                });
                return;
            }
            const rows: Array<[string, string]> = [
                ['Funnel', `${c.bold(String(details.title ?? '(untitled)'))} ${c.dim(`#${details.id}`)}`],
                ['Code', String(details.code ?? '-')],
                ['Status', String(details.status ?? '-')],
                ['Domains', domains.length
                    ? domains.map((d) => `#${d.domain_id}${d.is_default ? ' (default)' : ''}`).join(', ') + (details.domain?.domain ? c.dim(`  ${details.domain.domain}`) : '')
                    : c.dim('none')],
                ['Checkout page', checkout
                    ? `${checkout.slug ? `/${checkout.slug}` : '(unknown page)'} ${c.dim(`#${checkout.id}`)}${checkout.isCheckoutPage === false ? c.yellow('  (no longer marked as a checkout page)') : ''}`
                    : c.dim('none — the merchant\'s checkout page is used')],
                ['Trigger pages', details.trigger_pages?.length ? details.trigger_pages.map((id) => `#${id}`).join(', ') : c.dim('none')],
                ['Entry rules', details.rules?.conditions?.length ? `${details.rules.conditions.length} condition(s), match ${details.rules.match ?? 'all'}` : c.dim('none')],
            ];
            const w = Math.max(...rows.map(([k]) => k.length));
            for (const [k, v] of rows) process.stdout.write(`${c.bold(k.padEnd(w))}  ${v}\n`);
        });

    cmd.command('settings <codeOrId>')
        .description('Change funnel settings. --checkout-page sets the checkout page this funnel sends buyers to.')
        .option('--checkout-page <slug|id|none>', 'A page marked as a checkout page (slug or id), or "none" to fall back to the merchant\'s checkout page.')
        .option('--json', 'Print result as JSON.')
        .addHelpText('after', `
Examples:
  # Send this funnel's buyers to /order-form
  $ ef funnels settings main-funnel --checkout-page order-form

  # Clear it (the merchant's checkout page is used again)
  $ ef funnels settings main-funnel --checkout-page none

The page must be marked as a checkout page first:
  $ ef pages settings order-form --checkout-page

Which checkout page a buyer gets, first match wins:
  1. a set_checkout_page node on the buyer's path (funnel/page events graph)
  2. the funnel's checkout page (this setting)
  3. the merchant's checkout page

Only the checkout page changes: the title, status, domains and entry rules are
read from the server and sent back as they are.`)
        .action(async (codeOrId: string, opts: { checkoutPage?: string; json?: boolean }) => {
            if (opts.checkoutPage === undefined) {
                throw new CliError(ExitCode.Validation, 'Nothing to change — pass --checkout-page <slug|id|none>.');
            }
            const { api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);

            const ref = opts.checkoutPage.trim();
            let checkoutPageId: number | null = null;
            let pageLabel = 'none';
            if (!/^(none|null|-)$/i.test(ref)) {
                const { id } = await resolveAnyPageId(api, brandId, ref);
                const page = await api.getPageDetails(brandId, id);
                const slug = (page.slug ?? page.variant_slug ?? String(id)) as string;
                if (!(page as Record<string, unknown>).is_checkout_page) {
                    throw new CliError(ExitCode.Validation,
                        `Page "${slug}" (#${id}) is not marked as a checkout page — mark it first: ef pages settings ${slug} --checkout-page`);
                }
                checkoutPageId = id;
                pageLabel = `/${slug} (#${id})`;
            }

            const current = await api.getFunnel(brandId, funnel.id);
            const previous = current.checkout_page_id == null ? null : Number(current.checkout_page_id);
            const payload = buildFunnelUpdatePayload(current, { checkout_page_id: checkoutPageId });
            await api.updateFunnel(brandId, funnel.id, payload);

            // Read it back: the checkout page must have moved, and nothing else may have.
            const after = await api.getFunnel(brandId, funnel.id);
            const domainKey = (f: FunnelDetails) => JSON.stringify((f.domains ?? []).map((d) => [d.domain_id, Boolean(d.is_default)]).sort());
            if ((after.checkout_page_id == null ? null : Number(after.checkout_page_id)) !== checkoutPageId) {
                throw new CliError(ExitCode.Server, `The server accepted the update but funnel #${funnel.id} still reports checkout_page_id ${after.checkout_page_id ?? 'null'}.`);
            }
            if (domainKey(after) !== domainKey(current) || (after.status ?? null) !== (current.status ?? null)) {
                log.warn(`Funnel #${funnel.id}'s domains or status differ after the update — check with "ef funnels get ${funnel.code ?? funnel.id}".`);
            }

            if (opts.json) {
                log.json({ ok: true, funnel: { id: funnel.id, code: funnel.code ?? null }, checkout_page_id: checkoutPageId, previous_checkout_page_id: previous });
                return;
            }
            log.success(checkoutPageId == null
                ? `Funnel "${funnel.code ?? funnel.id}" (#${funnel.id}) has no checkout page of its own — the merchant's checkout page is used.`
                : `Funnel "${funnel.code ?? funnel.id}" (#${funnel.id}) now sends buyers to ${pageLabel}.`);
            if (previous != null && previous !== checkoutPageId) log.detail(`  Was page #${previous}.`);
            log.detail('  A set_checkout_page node on the buyer\'s path still wins over this.');
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

    cmd.command('validate <codeOrId>')
        .description('Validate the funnel builder graph (the local file, or --stored for the server\'s). Same engine as page events.')
        .option('--stored', 'Validate the graph currently on the server instead of the local file.')
        .option('--json', 'Print the validator report as JSON.')
        .action(async (codeOrId: string, opts: { stored?: boolean; json?: boolean }) => {
            const { rt, api, brandId } = await ctx();
            const funnel = await resolveFunnel(api, brandId, codeOrId);
            const graph = opts.stored ? undefined : readLocalFunnelGraph(rt, funnel.code ?? String(funnel.id)).graph;
            const report = await api.validateFunnelBuilder(brandId, funnel.id, graph) as { stats?: { errors?: number; warnings?: number }; errors?: unknown[]; warnings?: unknown[] };
            const errors = report.stats?.errors ?? (Array.isArray(report.errors) ? report.errors.length : 0);
            const warnings = report.stats?.warnings ?? (Array.isArray(report.warnings) ? report.warnings.length : 0);
            if (opts.json) { log.json(report); }
            else if (errors === 0 && warnings === 0) log.success('Funnel graph is valid.');
            else log.info(`${errors} error(s), ${warnings} warning(s). Run with --json for details.`);
            if (errors > 0) process.exitCode = ExitCode.Validation;
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
