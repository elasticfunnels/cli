import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { fetchPagePreviewBundle, readJsonPayloadFile, removeLocalEntity, resolvePageBySlug } from './shared';
import { relPathForPage } from '../sync/paths';
import { buildSyncContext, pullPage } from '../sync/sync';
import { printPagesList } from './list';

export function registerPagesCommand(program: Command): void {
    const cmd = program
        .command('pages')
        .description('Page-specific actions: list, create, publish, preview, duplicate, delete.');

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
        .description('Update page settings (slug, domain, folder, status, SEO) — separate from the editor HTML.')
        .option('--title <title>', 'Page title.')
        .option('--slug <slug>', 'New URL slug.')
        .option('--domain-id <id>', 'Numeric brand-domain id.', (v) => parseInt(v, 10))
        .option('--folder-id <id>', 'Numeric folder id.', (v) => parseInt(v, 10))
        .option('--status <status>', 'published | draft | offline | imported.')
        .option('--is-index', 'Mark this page as the domain index (homepage).')
        .option('--no-is-index', 'Unmark this page as the domain index.')
        .option('--seo-title <text>', 'SEO title.')
        .option('--seo-description <text>', 'SEO description.')
        .option('--seo-blur-title <text>', 'SEO blur title.')
        .option('--file <path>', 'JSON payload file ("-" for stdin). Flags override its fields.')
        .option('--json', 'Print result as JSON.')
        .action(async (slug: string, opts: {
            title?: string; slug?: string; domainId?: number; folderId?: number;
            status?: string; isIndex?: boolean; seoTitle?: string; seoDescription?: string;
            seoBlurTitle?: string; file?: string; json?: boolean;
        }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slug);

            const base = opts.file ? await readJsonPayloadFile(opts.file) : {};
            const flags: Record<string, unknown> = {};
            if (opts.title !== undefined) flags.title = opts.title;
            if (opts.slug !== undefined) flags.slug = opts.slug;
            if (opts.domainId !== undefined) flags.domain_id = opts.domainId;
            if (opts.folderId !== undefined) flags.folder_id = opts.folderId;
            if (opts.status !== undefined) flags.status = opts.status;
            if (opts.isIndex !== undefined) flags.is_index = opts.isIndex;
            if (opts.seoTitle !== undefined) flags.seo_title = opts.seoTitle;
            if (opts.seoDescription !== undefined) flags.seo_description = opts.seoDescription;
            if (opts.seoBlurTitle !== undefined) flags.seo_blur_title = opts.seoBlurTitle;

            const payload: Record<string, unknown> = { ...base, ...flags };
            if (Object.keys(payload).length === 0) {
                throw new CliError(ExitCode.Validation, 'Nothing to change — pass at least one setting flag or --file.');
            }
            // The server always requires a title; fall back to the current one.
            if (payload.title == null) payload.title = page.title ?? '';

            const updated = await api.updatePageSettings(rt.config.brandId, page.id, payload);
            if (opts.json) { log.json({ ok: true, page: updated }); return; }
            log.success(`Updated settings for page #${page.id} (${updated.slug ?? page.slug}).`);
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
