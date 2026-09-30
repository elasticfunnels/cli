import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Page } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';

/**
 * `ef pages get <idOrSlug>` — one page's settings, for ANY page type.
 *
 * `ef get page` prints a page's editor HTML, and `ef list pages` lists only
 * code-editor pages (what syncs). Funnel analysis mostly meets page ids — from
 * orders, sessions and funnel graphs — that belong to visual-builder or legacy
 * pages, and needs to know what they are and where they live. This answers that
 * without touching content.
 */

/** Fields reported. An allowlist, so the page password hash can never leak. */
const FIELDS = [
    'id', 'title', 'slug', 'variant_slug', 'status', 'page_type', 'domain_id',
    'is_index', 'is_checkout_page', 'is_upsell_page', 'has_buy_link',
    'page_classification', 'parent_page_id', 'is_active_version', 'version_index',
    'folder_id', 'requires_login', 'prevent_indexing', 'include_in_sitemap',
] as const;

type Listed = Page & { page_type?: string | null; url?: string | null; domain?: { domain?: string | null } | string | null };

function stripPreview(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        u.searchParams.delete('preview');
        return u.toString().replace(/\?$/, '');
    } catch {
        return url;
    }
}

/**
 * Resolve a page id from an id or slug across EVERY page type (editor, builder,
 * legacy) — checkout pages are often builder pages that the editor-only
 * listing leaves out. Several versions on one slug resolve to the active one.
 */
export async function resolveAnyPageId(api: ApiClient, brandId: number, idOrSlug: string): Promise<{ id: number; all: Listed[] }> {
    const all = (await api.listPages(brandId, 100000, { allTypes: true })) as Listed[];
    if (/^\d+$/.test(idOrSlug)) return { id: Number(idOrSlug), all };
    const slug = idOrSlug.replace(/^\/+/, '');
    const matches = all.filter(p => p.slug === slug || p.variant_slug === slug);
    if (matches.length === 0) throw new CliError(ExitCode.NotFound, `No page with slug "${slug}" (any type). "ef list pages --all" lists them.`);
    return { id: (matches.find(m => m.is_active_version) ?? matches[0]).id, all };
}

export function registerPageGetCommand(pages: Command): void {
    pages.command('get <idOrSlug>')
        .description('Show one page\'s details (any type — editor, builder or legacy): slug, status, domain, public URL, checkout/upsell flags.')
        .option('--json', 'Print as JSON.')
        .addHelpText('after', `
Examples:
  $ ef pages get 312
  $ ef pages get last-chance
  $ ef pages get 718 --json

Unlike "ef get page" (the page's HTML), this reads settings only, and it finds
visual-builder and legacy pages that "ef list pages" leaves out ("--all" there
lists them).`)
        .action(async (idOrSlug: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const { id, all } = await resolveAnyPageId(api, rt.config.brandId, idOrSlug);

            const page = await api.getPageDetails(rt.config.brandId, id);
            const listed = all.find(p => p.id === id);
            const domainName = typeof page.domain === 'object' && page.domain
                ? (page.domain as { domain?: string | null }).domain ?? null
                : (typeof page.domain === 'string' ? page.domain : null);
            const url = stripPreview(listed?.url) ?? await api.getLiveUrl(rt.config.brandId, id).catch(() => null);

            const details: Record<string, unknown> = {};
            for (const f of FIELDS) details[f] = (page as Record<string, unknown>)[f] ?? null;
            details.page_type = details.page_type ?? 'legacy';
            details.domain = domainName;
            details.url = url;

            if (opts.json) { log.json({ ok: true, page: details }); return; }

            const yes = (v: unknown) => (v ? 'yes' : 'no');
            const rows: Array<[string, string]> = [
                ['Page', `${c.bold(String(page.title ?? '(untitled)'))} ${c.dim(`#${page.id}`)}`],
                ['Slug', page.slug
                    ? `/${page.slug}${page.variant_slug && page.variant_slug !== page.slug ? c.dim(`  (variant slug: ${page.variant_slug})`) : ''}`
                    : `${c.dim('(none — variant)')} variant slug: ${page.variant_slug ?? '-'}`],
                ['Status', String(page.status ?? '-')],
                ['Type', `${details.page_type}${details.page_type === 'editor' ? '' : c.dim(' (does not sync to .ef files)')}`],
                ['Domain', domainName ?? c.dim('none assigned — served on the brand default')],
                ['URL', url ?? '-'],
                ['Homepage', yes(details.is_index)],
                ['Checkout page', yes(details.is_checkout_page)],
                ['Upsell page', yes(details.is_upsell_page)],
            ];
            if (details.parent_page_id) rows.push(['Variant of', `#${details.parent_page_id}${details.is_active_version ? ' (active version)' : ''}`]);
            if (details.page_classification) rows.push(['Classified as', `${details.page_classification}${details.has_buy_link ? ', has buy link' : ''}`]);
            const w = Math.max(...rows.map(([k]) => k.length));
            for (const [k, v] of rows) process.stdout.write(`${c.bold(k.padEnd(w))}  ${v}\n`);
        });
}
