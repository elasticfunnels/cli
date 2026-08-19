import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Page } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { EfRuntime, loadRuntime } from '../utils/store';
import { sha256, writeFileAtomic } from '../utils/fs';
import { readSnapshot, writeSnapshot } from '../sync/baselineSnapshots';
import { canonical, graphHash } from '../sync/graph';
import { ensureNodeCodes } from '../sync/nodeCodes';
import { resolvePageBySlug } from './shared';
import { relPathForPage, safeJoinBrandRoot } from '../sync/paths';
import { unifiedDiff } from '../sync/merge';

/** Starter graph written when a page has no events yet, so it's editable. */
const EMPTY_GRAPH = { drawflow: { Home: { data: {} } } };

export interface EventsDiffEntry {
    rel: string;
    kind: 'events';
    serverId: number | null;
    status: 'clean' | 'dirty' | 'server-newer' | 'both-changed' | 'local-only' | 'unknown';
    note?: string;
    diff?: string;
}

/** Diff a `pages/<slug>.events.json` file against the server graph. Used by
 *  `ef diff pages/x.events.json` so events diff the same way as any other file. */
export async function eventsDiffEntry(rt: EfRuntime, api: ApiClient, abs: string): Promise<EventsDiffEntry> {
    const rel = path.relative(rt.brandRoot, abs).split(path.sep).join('/');
    let local: unknown;
    try { local = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch {
        return { rel, kind: 'events', serverId: null, status: 'unknown', note: 'invalid JSON' };
    }
    const slug = rel.replace(/^pages\//, '').replace(/\.events\.json$/i, '');
    let page: Page;
    try { page = await resolvePageBySlug(api, rt.config.brandId, slug); } catch {
        return { rel, kind: 'events', serverId: null, status: 'local-only', note: `no page with slug "${slug}"` };
    }
    const server = (await api.getPageEvents(rt.config.brandId, page.id)) ?? EMPTY_GRAPH;
    const localHash = graphHash(local);
    const serverHash = graphHash(server);
    const baseline = await readSnapshot(rt.brandRoot, 'pageEvents', page.id);
    const baseHash = baseline ? sha256(baseline) : null;
    let status: EventsDiffEntry['status'];
    if (localHash === serverHash) status = 'clean';
    else if (baseHash == null) status = 'dirty';
    else {
        const localChanged = localHash !== baseHash;
        const serverChanged = serverHash !== baseHash;
        status = localChanged && serverChanged ? 'both-changed' : serverChanged ? 'server-newer' : 'dirty';
    }
    return {
        rel, kind: 'events', serverId: page.id, status,
        diff: status === 'clean' ? undefined : unifiedDiff(JSON.stringify(server, null, 2) + '\n', JSON.stringify(local, null, 2) + '\n', 'server', 'local'),
    };
}

/** `pages/<slug>.events.json` beside the page's `.ef` (nested slugs preserved). */
function eventsRelForPage(page: Page): string {
    return relPathForPage(page).replace(/\.ef$/i, '.events.json');
}

async function writeEventsFile(rt: EfRuntime, page: Page, graph: unknown): Promise<string> {
    const rel = eventsRelForPage(page);
    const abs = safeJoinBrandRoot(rt.brandRoot, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, JSON.stringify(graph, null, 2) + '\n');
    return rel;
}

/** Pull events for one page; writes the file only when non-empty unless `skeleton`. */
export async function pullEventsForPage(rt: EfRuntime, api: ApiClient, page: Page, opts: { skeleton?: boolean } = {}): Promise<{ rel: string; empty: boolean } | null> {
    const graph = await api.getPageEvents(rt.config.brandId, page.id);
    if (!graph && !opts.skeleton) return null;
    const finalGraph = graph ?? EMPTY_GRAPH;
    const rel = await writeEventsFile(rt, page, finalGraph);
    // Baseline for the push-time drift check (lost-update protection).
    await writeSnapshot(rt.brandRoot, 'pageEvents', page.id, Buffer.from(canonical(finalGraph), 'utf8'));
    return { rel, empty: !graph };
}

/** Pull events for every page that has them (used by `ef pull --events`). */
export async function pullEventsForAllPages(rt: EfRuntime, api: ApiClient): Promise<string[]> {
    const pages = await api.listPages(rt.config.brandId);
    const written: string[] = [];
    for (const page of pages) {
        const r = await pullEventsForPage(rt, api, page).catch(() => null);
        if (r) written.push(r.rel);
    }
    return written;
}

function readLocalGraph(rt: EfRuntime, page: Page): { rel: string; graph: unknown } {
    const rel = eventsRelForPage(page);
    const abs = safeJoinBrandRoot(rt.brandRoot, rel);
    let raw: string;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch {
        throw new CliError(ExitCode.NotFound, `No events file at ${rel}. Run "ef pages events pull <slug>" first.`);
    }
    try { return { rel, graph: JSON.parse(raw) }; } catch (err) {
        throw new CliError(ExitCode.Validation, `${rel} is not valid JSON: ${(err as Error).message}`);
    }
}

/** Count validation issues in the server's report (shape-tolerant: the server
 *  returns one `errors` array whose items carry a `severity`, plus `valid`). */
function countIssues(report: unknown): { errors: number; warnings: number } {
    const r = (report ?? {}) as Record<string, unknown>;
    const list = Array.isArray(r.errors) ? r.errors : (Array.isArray(r.issues) ? r.issues : []);
    let errors = 0;
    let warnings = 0;
    for (const it of list) {
        const sev = (it && typeof it === 'object' ? (it as { severity?: string }).severity : undefined) ?? 'error';
        if (sev === 'warning') warnings++; else errors++;
    }
    if (Array.isArray(r.warnings)) warnings += r.warnings.length;
    return { errors, warnings };
}

export function registerPageEventsCommand(pages: Command): void {
    const ev = pages
        .command('events')
        .description('Page events / funnel builder graph (split tests, redirects, tags, popups). Not pulled by default.');

    ev.command('pull [slug]')
        .description('Pull a page\'s events graph → pages/<slug>.events.json. With --all, every page that has events.')
        .option('--all', 'Pull events for every page that has them.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string | undefined, opts: { all?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            if (opts.all || !slug) {
                const written = await pullEventsForAllPages(rt, api);
                if (opts.json) { log.json({ ok: true, pulled: written }); return; }
                for (const rel of written) log.info(`  ${c.green('pulled')} ${rel}`);
                log.success(`Pulled events for ${written.length} page${written.length === 1 ? '' : 's'} (pages with no events were skipped).`);
                return;
            }
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            const r = await pullEventsForPage(rt, api, page, { skeleton: true });
            if (opts.json) { log.json({ ok: true, pulled: r?.rel, empty: r?.empty ?? true }); return; }
            log.success(r?.empty ? `Page has no events yet — wrote a starter graph to ${r.rel}.` : `Pulled events → ${r?.rel}.`);
        });

    ev.command('push <slug>')
        .description('Push pages/<slug>.events.json (validates first; REFUSES if the server changed since you pulled).')
        .option('--no-validate', 'Skip the pre-push validation.')
        .option('--strict', 'Refuse to push if validation reports errors.')
        .option('--force', 'Push even if the server\'s graph changed since you pulled (overwrites it).')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: { validate?: boolean; strict?: boolean; force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            const { rel, graph } = readLocalGraph(rt, page);

            // Lost-update protection. A structured JSON graph can't be text-merged
            // safely, so we DON'T auto-merge: refuse, and the user picks a side
            // ("ef pages events diff" to see; --force = keep local; pull --force = take server).
            if (!opts.force) {
                const baseline = await readSnapshot(rt.brandRoot, 'pageEvents', page.id);
                const server = await api.getPageEvents(rt.config.brandId, page.id);
                const serverHash = graphHash(server ?? EMPTY_GRAPH);
                const localHash = graphHash(graph);
                if (baseline) {
                    // We pulled before: refuse if the server moved off our baseline
                    // (and our local isn't already identical to what's on the server).
                    if (serverHash !== sha256(baseline) && serverHash !== localHash) {
                        const msg = `Changes rejected: events for "${page.slug ?? slug}" changed on the server since you pulled. `
                            + `Run "ef pages events diff ${slug}" to see the difference, then "ef pages events pull ${slug} --force" to take the server's, or "ef pages events push ${slug} --force" to overwrite it.`;
                        if (opts.json) log.json({ ok: false, conflict: true, rel, message: msg });
                        else log.error(msg);
                        process.exitCode = ExitCode.Conflict;
                        return;
                    }
                } else if (serverHash !== graphHash(EMPTY_GRAPH) && serverHash !== localHash) {
                    // Never pulled, but the server already has events: pushing now would
                    // clobber edits we've never seen. Force a pull first (always-pull-first).
                    const msg = `Changes rejected: "${page.slug ?? slug}" already has events on the server, but you never pulled them. `
                        + `Run "ef pages events pull ${slug}" first (then re-apply your change), or "ef pages events push ${slug} --force" to overwrite.`;
                    if (opts.json) log.json({ ok: false, conflict: true, rel, message: msg });
                    else log.error(msg);
                    process.exitCode = ExitCode.Conflict;
                    return;
                }
            }

            let report: unknown = null;
            if (opts.validate !== false) {
                report = await api.validatePageEvents(rt.config.brandId, page.id, graph, opts.strict);
                const { errors } = countIssues(report);
                if (errors > 0 && opts.strict) {
                    if (opts.json) { log.json({ ok: false, rel, validation: report }); }
                    else log.error(`Refusing to push ${rel}: ${errors} validation error(s). Fix them or drop --strict.`);
                    process.exitCode = ExitCode.Validation;
                    return;
                }
            }
            // Mint any missing node_code BEFORE the push. The server reads this
            // field and never generates it, so a hand-authored graph that omits
            // it splits traffic correctly and then reports variants as `j:null`
            // and `` — a failure that only shows up in `ef stats split` days
            // later. Existing codes are left alone: they are what ties a running
            // test's recorded sessions together.
            const codes = ensureNodeCodes(graph);
            if (codes.filled.length > 0 && !opts.json) {
                log.detail(`Assigned node_code to ${codes.filled.length} node(s) — the server does not, and split-test reporting needs it.`);
            }

            await api.setPageEvents(rt.config.brandId, page.id, graph);
            // Adopt the server's normalized graph (positions, split-test ids) as the
            // new local file + baseline so the next push isn't a phantom drift.
            const normalized = await api.getPageEvents(rt.config.brandId, page.id).catch(() => null);
            // Write back the server's copy when we have it. When we do not, the
            // locally-filled graph still has to land on disk: the codes were
            // minted in memory and are now live on the server, so a local file
            // without them would mint DIFFERENT ones on the next push and orphan
            // every session already recorded against the old ones.
            if (normalized) await writeEventsFile(rt, page, normalized);
            else if (codes.filled.length > 0) await writeEventsFile(rt, page, graph);
            await writeSnapshot(rt.brandRoot, 'pageEvents', page.id, Buffer.from(canonical(normalized ?? graph), 'utf8'));

            if (opts.json) { log.json({ ok: true, pushed: rel, pageId: page.id, validation: report }); return; }
            const { errors, warnings } = countIssues(report);
            log.success(`Pushed events for "${page.slug ?? slug}" (page #${page.id}).`);
            if (errors) log.warn(`${errors} validation error(s) — pushed anyway; add --strict to block on errors.`);
            else if (warnings) log.detail(`${warnings} validation warning(s).`);
        });

    ev.command('diff <slug>')
        .description('Show the difference between the local events graph and the server\'s (no merge — you decide which to keep).')
        .option('--json', 'Print { changed, local, server } as JSON.')
        .action(async (slug: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            const { rel, graph } = readLocalGraph(rt, page);
            const server = (await api.getPageEvents(rt.config.brandId, page.id)) ?? EMPTY_GRAPH;
            const changed = graphHash(graph) !== graphHash(server);
            if (opts.json) { log.json({ changed, local: graph, server }); return; }
            if (!changed) { log.success(`No difference — ${rel} matches the server.`); return; }
            log.raw(unifiedDiff(JSON.stringify(server, null, 2) + '\n', JSON.stringify(graph, null, 2) + '\n', 'server', 'local'));
        });

    ev.command('validate <slug>')
        .description('Validate the events graph (the local file, or --stored for the server\'s).')
        .option('--stored', 'Validate the graph currently on the server instead of the local file.')
        .option('--json', 'Print the validator report as JSON.')
        .action(async (slug: string, opts: { stored?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            const graph = opts.stored ? undefined : readLocalGraph(rt, page).graph;
            const report = await api.validatePageEvents(rt.config.brandId, page.id, graph);
            const { errors, warnings } = countIssues(report);
            if (opts.json) { log.json(report); }
            else if (errors === 0 && warnings === 0) log.success('Events graph is valid.');
            else log.info(`${errors} error(s), ${warnings} warning(s). Run with --json for details.`);
            if (errors > 0) process.exitCode = ExitCode.Validation;
        });

    ev.command('vocabulary <slug>')
        .alias('node-types')
        .description('Print the valid event-node vocabulary (node types + connection rules) as JSON.')
        .action(async (slug: string) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            log.json(await api.getPageEventsVocabulary(rt.config.brandId, page.id));
        });
}
