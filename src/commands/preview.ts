import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { loadRuntime } from '../utils/store';
import { log } from '../utils/log';
import { fetchPagePreviewBundle, printPreviewBundle, resolvePageBySlug } from './shared';
import { isOfflineStatus, offlinePageNote } from '../sync/sync';

/**
 * Top-level `ef preview` — mirrors the extension’s “Preview draft” flow
 * (revision from editor) and prints the live URL when available.
 */
export function registerPreviewCommand(program: Command): void {
    program
        .command('preview <slugOrId>')
        .description('Print preview URL for a page (same API as the VS Code extension).')
        .option('--live', 'Open only the public live site URL (no editor preview).')
        .option('--json', 'Print URLs as JSON.')
        .action(async (slugOrId: string, opts: { live?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const page = await resolvePageBySlug(api, rt.config.brandId, slugOrId);
            if (opts.live) {
                const offline = isOfflineStatus(page.status);
                const liveUrl = offline ? null : await api.getLiveUrl(rt.config.brandId, page.id).catch(() => null);
                if (opts.json) {
                    log.json({ ok: true, pageId: page.id, liveUrl });
                    return;
                }
                if (offline) log.warn(offlinePageNote(page.slug ?? slugOrId));
                else if (!liveUrl) log.info('No live URL returned for this page.');
                else log.info(liveUrl);
                return;
            }
            const bundle = await fetchPagePreviewBundle(api, rt.config.brandId, page.id);
            if (opts.json) {
                log.json({ ok: true, pageId: page.id, ...bundle });
                return;
            }
            printPreviewBundle(page.slug ?? slugOrId, bundle);
        });
}
