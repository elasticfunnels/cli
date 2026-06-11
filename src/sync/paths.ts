import * as path from 'path';
import { Asset, BackendScript, Component, Page } from '../api/types';
import { normalizeAssetPath } from '../api/client';

/**
 * Server entity → on-disk relative path conventions. Mirror the VS Code
 * extension exactly so the same brand can be edited by both tools and
 * `.ef-state.json` stays compatible.
 *
 * All paths returned here are POSIX-style ("/"), brand-root-relative.
 * Convert with `path.join(brandRoot, …rel)` for filesystem use.
 */

export function pageEffectiveSlug(p: Pick<Page, 'slug' | 'variant_slug' | 'id'>): string {
    const s = (p.slug || p.variant_slug || `page-${p.id}`).trim();
    return s.replace(/^\/+|\/+$/g, '');
}

export function relPathForPage(p: Pick<Page, 'slug' | 'variant_slug' | 'id'>): string {
    const slug = pageEffectiveSlug(p);
    return `pages/${slug}.ef`;
}

export function relPathForComponent(c: Pick<Component, 'code' | 'name' | 'id'>): string {
    const code = (c.code || c.name || `component-${c.id}`).trim().replace(/^\/+|\/+$/g, '');
    return `components/${code}.ef`;
}

export function relPathForScript(s: Pick<BackendScript, 'code' | 'id'>): string {
    const code = (s.code || `script-${s.id}`).trim().replace(/^\/+|\/+$/g, '');
    return `scripts/${code}.js`;
}

export function relPathForAsset(a: Pick<Asset, 'file_path' | 'file_name' | 'id'>): string {
    const fp = normalizeAssetPath(a.file_path || a.file_name || `${a.id}`);
    return `assets/${fp}`;
}

/** Convert an arbitrary brand-root-relative POSIX path back to an absolute
 *  filesystem path. Defends against `..` traversal so a malicious server
 *  payload can't write outside the brand root. */
export function safeJoinBrandRoot(brandRoot: string, rel: string): string {
    const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const absolute = path.resolve(brandRoot, normalized);
    const root = path.resolve(brandRoot);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
        throw new Error(`Refusing to write outside brand root: ${rel}`);
    }
    return absolute;
}

/** Best-effort: derive the entity kind from a brand-root-relative path. */
export function kindFromRel(rel: string): 'page' | 'component' | 'templatePage' | 'script' | 'asset' | null {
    const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (r.startsWith('pages/')) return 'page';
    if (r.startsWith('components/')) return 'component';
    if (r.startsWith('templates/')) return 'templatePage';
    if (r.startsWith('scripts/')) return 'script';
    if (r.startsWith('assets/')) return 'asset';
    return null;
}

export const TEXT_ASSET_EXTS = new Set([
    'css', 'js', 'mjs', 'cjs', 'json', 'xml', 'svg', 'txt', 'html', 'htm', 'csv', 'md', 'yml', 'yaml',
]);

export function isTextAssetPath(p: string): boolean {
    const ext = (p.split('.').pop() || '').toLowerCase();
    return TEXT_ASSET_EXTS.has(ext);
}
