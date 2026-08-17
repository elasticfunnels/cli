import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Page } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { EfRuntime, loadRuntime } from '../utils/store';
import { fetchPagePreviewBundle, readJsonPayloadFile, removeLocalEntity, resolvePageBySlug } from './shared';
import { relPathForPage, safeJoinBrandRoot } from '../sync/paths';
import { EfMeta, parseEfMeta, withEfMeta } from '../sync/efMeta';
import { fileExists, sha256, writeFileAtomic } from '../utils/fs';
import { registerPageEventsCommand } from './pageEvents';
import { SyncStateFile } from '../sync/stateFile';
import { buildSyncContext, pullPage } from '../sync/sync';
import { printPagesList } from './list';
import { resolveDomain, statusLabel as domainStatusLabel } from './domains';

/**
 * When a page's slug changes on the server, move its local `.ef` file to match
 * (e.g. pages/old.ef → pages/new.ef): preserve the body, rewrite the embedded
 * efmeta (slug/name/path), and move the `.ef-state.json` path→id entry so drift
 * detection and `ef push` target the new path. Returns the rename, or null when
 * there's nothing on disk to move or the path didn't change.
 */
async function renameLocalPageFile(rt: EfRuntime, pageId: number, oldRel: string, newRel: string, updated: Page): Promise<{ from: string; to: string } | null> {
    if (oldRel === newRel) return null;
    const oldAbs = safeJoinBrandRoot(rt.brandRoot, oldRel);
    if (!(await fileExists(oldAbs))) return null;
    const newAbs = safeJoinBrandRoot(rt.brandRoot, newRel);

    const { meta, body } = parseEfMeta(await fs.promises.readFile(oldAbs, 'utf8'));
    const newMeta: EfMeta = {
        ...(meta ?? { v: 1 as const, type: 'page' as const, brandId: rt.config.brandId, id: pageId }),
        type: 'page',
        id: pageId,
        slug: updated.slug ?? undefined,
        name: updated.title ?? meta?.name,
        path: newRel,
    };
    await fs.promises.mkdir(path.dirname(newAbs), { recursive: true });
    await writeFileAtomic(newAbs, withEfMeta(newMeta, body));
    if (path.resolve(newAbs) !== path.resolve(oldAbs)) {
        await fs.promises.unlink(oldAbs).catch(() => { /* already gone */ });
    }

    const state = await SyncStateFile.load(rt.brandRoot, rt.config.brandId);
    const prev = state.getByPath('page', oldRel);
    state.deleteEntry('page', oldRel);
    state.setEntry('page', {
        path: newRel,
        id: pageId,
        type: 'page',
        revisionId: prev?.revisionId ?? updated.revision_id ?? null,
        updatedAt: updated.updated_at ?? new Date().toISOString(),
        serverUpdatedAt: prev?.serverUpdatedAt ?? updated.updated_at ?? null,
        contentHash: prev?.contentHash ?? sha256(Buffer.from(body, 'utf8')),
    });
    await state.save();
    return { from: oldRel, to: newRel };
}

export function registerPagesCommand(program: Command): void {
    const cmd = program
        .command('pages')
        .description('Page-specific actions: list, create, publish, preview, duplicate, delete, events.');

    registerPageEventsCommand(cmd);

    cmd.command('list')
        .alias('ls')
        .description('List all pages (same as `ef list pages`).')
        .option('--limit <n>', 'Limit rows shown (default: all).', (v) => parseInt(v, 10))
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { limit?: number; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            await printPagesList(api, rt.config.brandId, opts);
        });

    cmd.command('create <slug>')
        .description('Create a new page on the server (and pull it to disk).')
        .option('--title <title>', 'Title shown in the dashboard. Defaults to the slug humanized.')
        .option('--folder-id <id>', 'Numeric folder id to drop the page into.', (v) => parseInt(v, 10))
        .option('--no-pull', 'Skip pulling the new page to disk after creating.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: { title?: string; folderId?: number; pull?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const title = opts.title ?? humanize(slug);
            const created = await api.createPage(rt.config.brandId, title, slug, opts.folderId);
            if (opts.pull !== false) {
                const ctx = await buildSyncContext(rt);
                await pullPage(ctx, created.id);
                await ctx.state.save();
            }
            if (opts.json) { log.json({ ok: true, page: created }); return; }
            log.success(`Created page #${created.id} "${created.slug ?? slug}" (${created.title ?? title}).`);
        });

    cmd.command('settings <slug>')
        .description('Update page settings — assign a domain, make it that domain\'s homepage, change slug/folder/status/SEO. Separate from the editor HTML.')
        .addHelpText('after', `
Examples:
  # Put this page on a domain (name or numeric id both work)
  $ ef pages settings pricing --domain shop.example.com

  # ...and make it what visitors see at the domain root
  $ ef pages settings home --domain shop.example.com --homepage

  # Take a page off homepage duty without unassigning the domain
  $ ef pages settings home --no-homepage

  # Detach the page from any domain
  $ ef pages settings pricing --domain none

  # Publish this page in the brand's sitemap.xml and llms.txt (off by default)
  $ ef pages settings pricing --sitemap
  $ ef pages settings pricing --no-sitemap

Listing a page only has an effect once the brand serves the files — see
"ef seo status" and "ef seo set sitemap true".

Run "ef domains list" to see the brand's domains and their status. A domain has
to be validated before it actually serves traffic — "ef domains records <domain>"
prints the DNS records, "ef domains validate <domain>" triggers the check.`)
        .option('--title <title>', 'Page title.')
        .option('--slug <slug>', 'New URL slug.')
        .option('--domain <name-or-id>', 'Assign the page to this brand domain — a domain name ("shop.example.com") or its numeric id. Use "none" to detach.')
        .option('--domain-id <id>', 'Same as --domain, but numeric id only (kept for scripts).', (v) => parseInt(v, 10))
        .option('--homepage', 'Serve this page at the domain root — i.e. make it the domain\'s homepage.')
        .option('--no-homepage', 'Stop serving this page at the domain root.')
        .option('--folder-id <id>', 'Numeric folder id.', (v) => parseInt(v, 10))
        .option('--status <status>', 'published | draft | offline | imported.')
        .option('--is-index', 'Deprecated spelling of --homepage.')
        .option('--no-is-index', 'Deprecated spelling of --no-homepage.')
        .option('--seo-title <text>', 'SEO title.')
        .option('--seo-description <text>', 'SEO description.')
        .option('--seo-blur-title <text>', 'SEO blur title.')
        .option('--sitemap', 'List this page in the brand\'s sitemap.xml and llms.txt.')
        .option('--no-sitemap', 'Stop listing this page in sitemap.xml and llms.txt.')
        .option('--file <path>', 'JSON payload file ("-" for stdin). Flags override its fields.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: {
            title?: string; slug?: string; domain?: string; domainId?: number; folderId?: number;
            status?: string; isIndex?: boolean; homepage?: boolean; seoTitle?: string; seoDescription?: string;
            seoBlurTitle?: string; sitemap?: boolean; file?: string; json?: boolean;
        }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);

            const base = opts.file ? await readJsonPayloadFile(opts.file) : {};
            const flags: Record<string, unknown> = {};
            if (opts.title !== undefined) flags.title = opts.title;
            if (opts.slug !== undefined) flags.slug = opts.slug;
            if (opts.folderId !== undefined) flags.folder_id = opts.folderId;
            if (opts.status !== undefined) flags.status = opts.status;

            // Domain: accept a name so nobody has to look an id up first — that
            // extra step is most of the reason this was thought impossible.
            let domainLabel: string | null = null;
            if (opts.domain !== undefined) {
                const ref = opts.domain.trim();
                if (/^(none|null|-)$/i.test(ref)) {
                    flags.domain_id = null;
                    domainLabel = 'none';
                } else {
                    const resolved = await resolveDomain(api, rt.config.brandId, ref);
                    flags.domain_id = resolved.id;
                    domainLabel = `${resolved.domain} (#${resolved.id})`;
                    if (resolved.status && resolved.status !== 'validated') {
                        log.warn(`Domain ${resolved.domain} is "${domainStatusLabel(resolved.status)}" — the page is assigned, but the domain won't serve traffic until it validates. See "ef domains records ${resolved.domain}".`);
                    }
                }
            } else if (opts.domainId !== undefined) {
                flags.domain_id = opts.domainId;
                domainLabel = `#${opts.domainId}`;
            }

            // `--homepage` is the discoverable name; `--is-index` is what the
            // server field is called and stays supported.
            const asHomepage = opts.homepage !== undefined ? opts.homepage : opts.isIndex;
            if (asHomepage !== undefined) flags.is_index = asHomepage;
            if (opts.seoTitle !== undefined) flags.seo_title = opts.seoTitle;
            if (opts.seoDescription !== undefined) flags.seo_description = opts.seoDescription;
            if (opts.seoBlurTitle !== undefined) flags.seo_blur_title = opts.seoBlurTitle;
            // Opt this page into the brand's sitemap.xml / llms.txt. Off for
            // every page until asked, because most pages in a brand are funnel
            // steps and checkouts that must never be advertised.
            if (opts.sitemap !== undefined) flags.include_in_sitemap = opts.sitemap;

            const payload: Record<string, unknown> = { ...base, ...flags };
            if (Object.keys(payload).length === 0) {
                throw new CliError(ExitCode.Validation, 'Nothing to change — pass at least one setting flag or --file.');
            }
            // The server always requires a title; fall back to the current one.
            if (payload.title == null) payload.title = page.title ?? '';

            const updated = await api.updatePageSettings(rt.config.brandId, page.id, payload);

            // A slug change moves the page's URL — keep the local .ef file in sync
            // so disk, efmeta and state match the new slug.
            const renamed = await renameLocalPageFile(rt, page.id, relPathForPage(page), relPathForPage(updated), updated);

            if (opts.json) { log.json({ ok: true, page: updated, renamed, domain: domainLabel, homepage: asHomepage ?? null, sitemap: opts.sitemap ?? null }); return; }
            log.success(`Updated settings for page #${page.id} (${updated.slug ?? page.slug}).`);
            if (domainLabel) {
                log.detail(domainLabel === 'none' ? '  Detached from its domain.' : `  Domain → ${domainLabel}`);
            }
            if (asHomepage !== undefined) {
                log.detail(asHomepage ? '  Now served at the domain root (homepage).' : '  No longer the domain homepage.');
            }
            if (opts.sitemap !== undefined) {
                log.detail(opts.sitemap
                    ? '  Listed in sitemap.xml and llms.txt — if the brand serves them ("ef seo status").'
                    : '  No longer listed in sitemap.xml or llms.txt.');
            }
            if (renamed) log.detail(`Renamed local file ${renamed.from} → ${renamed.to}`);
        });

    cmd.command('publish <slug>')
        .description('Publish the latest editor draft for a page.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            // "Publish" = re-save the same html with draft=false.
            const draft = await api.getPageContent(rt.config.brandId, page.id);
            const html = draft.html ?? '';
            const res = await api.updatePageHtml(rt.config.brandId, page.id, html, { draft: false });
            if (opts.json) { log.json({ ok: true, page: { id: page.id, slug: page.slug }, response: res }); return; }
            log.success(`Published page #${page.id} (${page.slug}).`);
            if (res.preview_url) log.detail(`Preview: ${res.preview_url}`);
        });

    cmd.command('preview <slug>')
        .description('Get the preview URL for a page (uses editor draft revision when present) and live URL.')
        .option('--json', 'Print URLs as JSON.')
        .action(async (slug: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            const { previewUrl, liveUrl, revisionId } = await fetchPagePreviewBundle(api, rt.config.brandId, page.id);
            if (opts.json) { log.json({ ok: true, previewUrl, liveUrl, revisionId }); return; }
            const label = revisionId != null ? `${c.bold('Preview (draft)')}` : `${c.bold('Preview')}`;
            log.info(`${label} ${previewUrl}`);
            if (liveUrl) log.info(`${c.bold('Live')}           ${liveUrl}`);
        });

    cmd.command('duplicate <slug>')
        .description('Duplicate a page on the server.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const original = await resolvePageBySlug(api, rt.config.brandId, slug);
            const dup = await api.duplicatePage(rt.config.brandId, original.id);
            if (opts.json) { log.json({ ok: true, page: dup }); return; }
            log.success(`Duplicated page "${original.slug}" → #${dup.id} (${dup.slug ?? '?'}).`);
        });

    cmd.command('delete <slug>')
        .description('Soft-delete a page on the server. Use --force to bypass confirmation in interactive runs.')
        .option('--force', 'Do not require confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete page #${page.id} "${page.slug}"?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deletePage(rt.config.brandId, page.id);
            const rel = relPathForPage(page);
            const fileRemoved = await removeLocalEntity(rt, 'page', rel);
            if (opts.json) { log.json({ ok: true, deleted: { id: page.id, slug: page.slug }, localFileRemoved: fileRemoved }); return; }
            log.success(`Deleted page #${page.id}.${fileRemoved ? ` Removed ${rel}.` : ''}`);
        });
}

function humanize(slug: string): string {
    return slug.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').replace(/(^|\s)\S/g, t => t.toUpperCase());
}
