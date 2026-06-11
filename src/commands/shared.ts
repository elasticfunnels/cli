import { ApiClient } from '../api/client';
import { Component, Page } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';

/** Preview URL uses GET /editor revision_id when present — same as the VS Code extension. */
export async function fetchPagePreviewBundle(
    api: ApiClient,
    brandId: number,
    pageId: number,
): Promise<{ previewUrl: string; liveUrl: string | null; revisionId: number | null }> {
    const editor = await api.getPageContent(brandId, pageId);
    const revisionId = editor.revision_id ?? null;
    const previewUrl = await api.getPreviewUrl(brandId, pageId, revisionId);
    const liveUrl = await api.getLiveUrl(brandId, pageId).catch(() => null);
    return { previewUrl, liveUrl, revisionId };
}

/**
 * Resolve a page by its slug (or id, if numeric). Used by `ef get`,
 * `ef pages publish`, `ef pages preview`, etc. Slugs are not unique
 * across variants — the page list returns one row per active variant
 * and per draft variant — so we prefer an active match if there is one.
 */
export async function resolvePageBySlug(
    api: ApiClient,
    brandId: number,
    slugOrId: string,
): Promise<Page> {
    const id = parseInt(slugOrId, 10);
    if (Number.isFinite(id) && /^\d+$/.test(slugOrId)) {
        const p = await api.getPageContent(brandId, id);
        return p;
    }

    const all = await api.listPages(brandId);
    const matches = all.filter(p => p.slug === slugOrId || p.variant_slug === slugOrId);
    if (matches.length === 0) {
        throw new CliError(ExitCode.NotFound, `No page with slug "${slugOrId}".`);
    }
    if (matches.length === 1) return matches[0];
    const active = matches.find(m => m.is_active_version);
    if (active) return active;
    return matches.sort((a, b) => Date.parse(b.updated_at ?? '0') - Date.parse(a.updated_at ?? '0'))[0];
}

export async function resolveComponentByCodeOrName(
    api: ApiClient,
    brandId: number,
    codeOrName: string,
): Promise<Component> {
    const id = parseInt(codeOrName, 10);
    if (Number.isFinite(id) && /^\d+$/.test(codeOrName)) {
        return await api.getComponentContent(brandId, id);
    }
    const all = await api.listComponents(brandId);
    const found = all.find(c => c.code === codeOrName || c.name === codeOrName);
    if (!found) throw new CliError(ExitCode.NotFound, `Component "${codeOrName}" not found.`);
    return await api.getComponentContent(brandId, found.id);
}
