import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Page } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { EfRuntime, loadRuntime } from '../utils/store';
import { writeFileAtomic } from '../utils/fs';
import { resolvePageBySlug } from './shared';
import { relPathForPage, safeJoinBrandRoot } from '../sync/paths';

/** Starter graph written when a page has no events yet, so it's editable. */
const EMPTY_GRAPH = { drawflow: { Home: { data: {} } } };

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
    const rel = await writeEventsFile(rt, page, graph ?? EMPTY_GRAPH);
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
        .description('Push pages/<slug>.events.json to the server (validates first).')
        .option('--no-validate', 'Skip the pre-push validation.')
        .option('--strict', 'Refuse to push if validation reports errors.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: { validate?: boolean; strict?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            const { rel, graph } = readLocalGraph(rt, page);

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
            await api.setPageEvents(rt.config.brandId, page.id, graph);
            if (opts.json) { log.json({ ok: true, pushed: rel, pageId: page.id, validation: report }); return; }
            const { errors, warnings } = countIssues(report);
            log.success(`Pushed events for "${page.slug ?? slug}" (page #${page.id}).`);
            if (errors) log.warn(`${errors} validation error(s) — pushed anyway; run "ef pages events push ${slug} --strict" to block on errors.`);
            else if (warnings) log.detail(`${warnings} validation warning(s).`);
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
