import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { BrandSeoConfig, SEO_EXCLUSION_REASON, SeoPage } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';

/**
 * `ef seo` — the three discovery files the page runtime serves per host:
 * sitemap.xml, llms.txt and robots.txt.
 *
 * Two levels, and both have to be on for a page to appear anywhere:
 *   1. the brand turns a file on here,
 *   2. each page opts in with `ef pages settings <slug> --sitemap`.
 *
 * Nothing is on by default, and that is the safety model rather than caution: a
 * brand's pages are mostly funnel steps, upsells, checkouts and thank-you
 * pages. A file that switched itself on would publish a map of all of them.
 */

/** Settable keys, in the order `ef seo status` prints them. */
const BOOLEAN_KEYS = ['sitemap', 'llms', 'robots'] as const;
const TEXT_KEYS = ['site-name', 'site-summary', 'llms-notes', 'robots-extra'] as const;

/** CLI key → the field name the API expects. */
const FIELD_BY_KEY: Record<string, string> = {
    sitemap: 'sitemap_enabled',
    llms: 'llms_enabled',
    robots: 'robots_enabled',
    'site-name': 'site_name',
    'site-summary': 'site_summary',
    'llms-notes': 'llms_notes',
    'robots-extra': 'robots_extra',
};

const ALL_KEYS = [...BOOLEAN_KEYS, ...TEXT_KEYS];

function parseBoolean(key: string, raw: string): boolean {
    const v = raw.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(v)) return true;
    if (['false', 'no', 'off', '0'].includes(v)) return false;
    throw new CliError(ExitCode.Validation, `"${key}" takes a boolean — use true/false (also accepted: on/off, yes/no, 1/0). Got "${raw}".`);
}

/** "on"/"off" with colour, so the status block scans at a glance. */
function onOff(enabled: boolean): string {
    return enabled ? c.green('on') : c.dim('off');
}

export function registerSeoCommand(program: Command): void {
    const cmd = program
        .command('seo')
        .description('Discovery files (sitemap.xml, llms.txt, robots.txt): status, set, pages.');

    cmd.command('status')
        .description('Show which discovery files this brand serves and what they would contain.')
        .addHelpText('after', `
Examples:
  $ ef seo status
  $ ef seo status --json

A file only lists pages that opted in individually:
  $ ef pages settings pricing --sitemap        # add a page
  $ ef pages settings pricing --no-sitemap     # remove it
  $ ef seo pages                               # see the full list`)
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const [seo, pages] = await Promise.all([
                api.getBrandSeo(rt.config.brandId),
                api.listSeoPages(rt.config.brandId),
            ]);

            const listed = pages.filter((p) => p.listed);
            const excluded = pages.filter((p) => !p.listed);

            if (opts.json) {
                log.json({
                    ok: true,
                    seo,
                    listed_pages: listed.length,
                    excluded_pages: excluded.length,
                    pages,
                });
                return;
            }

            log.info(`${c.bold('sitemap.xml')}  ${onOff(seo.sitemap_enabled)}`);
            log.info(`${c.bold('llms.txt')}     ${onOff(seo.llms_enabled)}`);
            log.info(`${c.bold('robots.txt')}   ${onOff(seo.robots_enabled)}`);

            if (seo.llms_enabled) {
                log.info('');
                log.info(`${c.bold('llms.txt heading')} ${seo.site_name_effective ?? ''}${seo.site_name ? '' : c.dim(' (brand name)')}`);
                if (seo.site_summary) log.detail(`  ${seo.site_summary}`);
                else log.detail('  No summary set — the file leads straight into the page list. "ef seo set site-summary <text>".');
            }

            // Stated only when it is actually the case: without robots.txt
            // nothing points a crawler at the sitemap, so most never find it.
            if (seo.sitemap_enabled && !seo.robots_enabled) {
                log.warn('robots.txt is off, so nothing points crawlers at your sitemap and most will never find it. "ef seo set robots true".');
            }

            log.info('');
            if (listed.length === 0) {
                log.info(`${c.bold('Listed pages')} none`);
                log.detail('  Add one with "ef pages settings <slug> --sitemap".');
            } else {
                log.info(`${c.bold('Listed pages')} ${listed.length}`);
                log.detail('  "ef seo pages" for the list.');
            }
            if (excluded.length > 0) {
                log.warn(`${excluded.length} page(s) opted in but are excluded — ticking the box did nothing for them. Run "ef seo pages" for the reason on each.`);
            }
            if (!seo.sitemap_enabled && !seo.llms_enabled && !seo.robots_enabled) {
                log.detail('Nothing is served yet — every one of these paths 404s. Turn one on with "ef seo set sitemap true".');
            }
        });

    cmd.command('get [key]')
        .description(`Print the SEO settings, or one key. Keys: ${ALL_KEYS.join(', ')}.`)
        .option('--json', 'Print as JSON.')
        .action(async (key: string | undefined, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const seo = await api.getBrandSeo(rt.config.brandId);

            if (key) {
                const field = FIELD_BY_KEY[key];
                if (!field) {
                    throw new CliError(ExitCode.Validation, `Unknown key "${key}". Keys: ${ALL_KEYS.join(', ')}.`);
                }
                const value = (seo as unknown as Record<string, unknown>)[field];
                if (opts.json) { log.json({ [key]: value ?? null }); return; }
                // stdout so it pipes
                process.stdout.write(`${value ?? ''}\n`);
                return;
            }

            if (opts.json) { log.json(seo); return; }
            for (const k of ALL_KEYS) {
                const value = (seo as unknown as Record<string, unknown>)[FIELD_BY_KEY[k]];
                process.stdout.write(`${k}=${value ?? ''}\n`);
            }
        });

    cmd.command('set <key> <value>')
        .description(`Change one SEO setting. Keys: ${ALL_KEYS.join(', ')}.`)
        .addHelpText('after', `
Examples:
  $ ef seo set sitemap true
  $ ef seo set robots true
  $ ef seo set llms true
  $ ef seo set site-name "Acme Supplements"
  $ ef seo set site-summary "Direct-to-consumer supplements and guides."
  $ ef seo set robots-extra "Disallow: /internal"

Booleans accept true/false, on/off, yes/no, 1/0. Text keys take a literal
string; pass "" to clear one.`)
        .option('--json', 'Print the updated settings as JSON.')
        .action(async (key: string, value: string, opts: { json?: boolean }) => {
            const field = FIELD_BY_KEY[key];
            if (!field) {
                throw new CliError(ExitCode.Validation, `Unknown key "${key}". Keys: ${ALL_KEYS.join(', ')}.`);
            }

            const isBoolean = (BOOLEAN_KEYS as readonly string[]).includes(key);
            const parsed: unknown = isBoolean ? parseBoolean(key, value) : value;

            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            await api.setBrandSeo(rt.config.brandId, { [field]: parsed });
            // Read back rather than trusting the echo, so `--json` reports the
            // whole bag as it now stands on the server.
            const seo = await api.getBrandSeo(rt.config.brandId);

            if (opts.json) { log.json({ ok: true, seo }); return; }
            log.success(isBoolean ? `${key} → ${parsed ? 'on' : 'off'}` : `Set ${key}.`);

            if (key === 'sitemap' && parsed === true && !seo.robots_enabled) {
                log.detail('  robots.txt is still off, so nothing points crawlers at the sitemap. "ef seo set robots true".');
            }
            if (isBoolean && parsed === true) {
                const pages = await api.listSeoPages(rt.config.brandId);
                if (pages.filter((p) => p.listed).length === 0) {
                    log.detail(pages.length === 0
                        ? '  No page has opted in yet, so the file will be empty. "ef pages settings <slug> --sitemap".'
                        : '  Pages have opted in, but every one of them is excluded, so the file will be empty. "ef seo pages" for why.');
                }
            }
        });

    cmd.command('pages')
        .description('List the pages that appear in this brand\'s discovery files.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const pages = await api.listSeoPages(rt.config.brandId);

            if (opts.json) { log.json({ ok: true, pages }); return; }

            if (pages.length === 0) {
                log.info('No page has opted in.');
                log.detail('Add one with "ef pages settings <slug> --sitemap".');
                return;
            }

            const rows = pages.map((p: SeoPage) => [
                String(p.id),
                p.title ?? '',
                p.domain ? `${p.domain}${p.path}` : `${p.path} (all domains)`,
                p.listed
                    ? 'listed'
                    : `NOT LISTED — ${p.excluded_reason ? SEO_EXCLUSION_REASON[p.excluded_reason] : 'excluded'}`,
            ]);
            process.stdout.write(renderTable({ head: ['ID', 'TITLE', 'URL', 'STATE'], rows }) + '\n');

            const excluded = pages.filter((p) => !p.listed);
            if (excluded.length > 0) {
                log.detail(`${excluded.length} page(s) opted in but are excluded — the flag is set, and the file still will not carry them until the reason above is resolved.`);
            }
        });
}

/** Exported for tests: the key → API field mapping the `set` command applies. */
export const SEO_FIELD_BY_KEY: Readonly<Record<string, string>> = FIELD_BY_KEY;
export { parseBoolean as parseSeoBoolean };
export type { BrandSeoConfig };
