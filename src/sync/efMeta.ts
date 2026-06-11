// efmeta — embedded metadata header used at the top of `.ef` files.
// Mirrors `vscode-extension/src/sync/efMeta.ts` exactly so files written
// by the CLI are interchangeable with files written by the extension.

export type EfMetaType = 'page' | 'component' | 'templatePage' | 'script';

export interface EfMeta {
    v: 1;
    type: EfMetaType;
    brandId: number;
    id: number;
    slug?: string;
    name?: string;
    stub?: boolean;
    remoteUpdatedAt?: string;
    revisionId?: number;
    templateSlug?: string;
    templateId?: number;
    pageSlug?: string;
    /**
     * Brand-root-relative POSIX path the meta was issued for (e.g. "pages/login.ef").
     * Lets the extension/CLI detect copies and force a new server entity instead
     * of trampling the original.
     */
    path?: string;
}

const TEMPLATE_PREFIX = '{{-- efmeta:';
const TEMPLATE_SUFFIX = ' --}}';

const LEGACY_HTML_PREFIX = '<!-- efmeta:';
const LEGACY_HTML_SUFFIX = ' -->';

export function serializeEfMeta(meta: EfMeta): string {
    return `${TEMPLATE_PREFIX}${JSON.stringify(meta)}${TEMPLATE_SUFFIX}`;
}

export function parseEfMeta(text: string): { meta: EfMeta | null; body: string } {
    // Strip a leading UTF-8 BOM. Some editors prepend one and the marker
    // check below would fail otherwise — treating a tagged file as
    // identity-less and risking accidental "create new server entity".
    const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const lines = normalized.split(/\r?\n/);
    if (lines.length === 0) return { meta: null, body: '' };

    const first = lines[0];

    if (first.startsWith(TEMPLATE_PREFIX) && first.endsWith(TEMPLATE_SUFFIX)) {
        const json = first.slice(TEMPLATE_PREFIX.length, first.length - TEMPLATE_SUFFIX.length);
        try {
            const meta = JSON.parse(json) as EfMeta;
            const body = lines.slice(1).join('\n');
            return { meta, body };
        } catch {
            return { meta: null, body: lines.slice(1).join('\n') };
        }
    }

    if (first.startsWith(LEGACY_HTML_PREFIX) && first.endsWith(LEGACY_HTML_SUFFIX)) {
        const json = first.slice(LEGACY_HTML_PREFIX.length, first.length - LEGACY_HTML_SUFFIX.length);
        try {
            const meta = JSON.parse(json) as EfMeta;
            const body = lines.slice(1).join('\n');
            return { meta, body };
        } catch {
            return { meta: null, body: lines.slice(1).join('\n') };
        }
    }

    return { meta: null, body: normalized };
}

export function withEfMeta(meta: EfMeta, body: string): string {
    return `${serializeEfMeta(meta)}\n${body ?? ''}`;
}
