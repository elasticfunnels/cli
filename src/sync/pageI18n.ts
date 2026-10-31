// Page and component language and translation link in the local `.ef` file (T1031-3).
//
// `ef pull` writes the page's `language` and `translation_of` (the source page's slug or the source component's code, so the line reads
// the same in every checkout) into the efmeta line. `ef push` sends them back when they differ from what
// was last pulled. The last-pulled values are the baseline, kept in `.ef-state.json` (entry.extra.i18n),
// so a file pulled before the language was set in the app never reverts the app's change: without a
// local edit, nothing is sent.
import { ApiClient } from '../api/client';
import { Component, Page } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { EfMeta } from './efMeta';
import { StateEntry } from './stateFile';

export interface PageI18n {
    language: string | null;
    translation_of: string | null;
}

/** True when the server payload carries the multilingual fields at all (older servers do not). */
export function serverHasI18n(page: object): boolean {
    return Object.prototype.hasOwnProperty.call(page, 'language') || Object.prototype.hasOwnProperty.call(page, 'translation_source_id');
}

interface IndexRow { id: number; slug: string | null; parent?: boolean }

/**
 * Slug (page) or code (component) <-> id for the brand. Pages load across all page types: a translation's
 * source can be a builder page. Loaded once per command, only when something actually needs it.
 */
export class SlugIndex {
    private rows: IndexRow[] | null = null;
    constructor(private readonly loader: () => Promise<IndexRow[]>, private readonly noun: 'page' | 'component') {}

    private async load(): Promise<IndexRow[]> {
        if (!this.rows) this.rows = await this.loader();
        return this.rows;
    }

    async slugOf(id: number): Promise<string | null> {
        const hit = (await this.load()).find(p => p.id === id);
        return hit?.slug ?? null;
    }

    /** The entity a slug names; page variants share their parent's slug, so the family's parent wins. */
    async idOf(slugOrId: string): Promise<number> {
        const ref = slugOrId.trim().replace(/^\/+/, '');
        if (/^\d+$/.test(ref)) return Number(ref);
        const matches = (await this.load()).filter(p => p.slug === ref);
        if (matches.length === 0) {
            throw new CliError(ExitCode.NotFound, this.noun === 'page'
                ? `No page with slug "${ref}". "ef list pages --all" lists every page.`
                : `No component with code "${ref}". "ef list components" lists them.`);
        }
        return (matches.find(p => p.parent) ?? matches[0]).id;
    }
}

export function pageIndex(api: ApiClient, brandId: number, seed?: Page[]): SlugIndex {
    const toRows = (all: Page[]): IndexRow[] => all.map(p => ({ id: p.id, slug: p.slug ?? null, parent: p.parent_page_id == null }));
    return new SlugIndex(async () => toRows(seed ?? await api.listPages(brandId, 100000, { allTypes: true })), 'page');
}

export function componentIndex(api: ApiClient, brandId: number, seed?: Component[]): SlugIndex {
    const toRows = (all: Component[]): IndexRow[] => all.map(c => ({ id: c.id, slug: c.code ?? null }));
    return new SlugIndex(async () => toRows(seed ?? await api.listComponents(brandId)), 'component');
}

/** The multilingual fields of a page or component payload. */
export interface I18nFields {
    language?: string | null;
    translation_source_id?: number | null;
    translation_stale?: boolean | null;
    translation_source_hash?: string | null;
}

export async function i18nFromEntity(page: I18nFields, index: SlugIndex): Promise<PageI18n> {
    const sourceId = page.translation_source_id ?? null;
    let translationOf: string | null = null;
    if (sourceId != null) translationOf = (await index.slugOf(sourceId)) ?? String(sourceId);
    return { language: page.language ? String(page.language) : null, translation_of: translationOf };
}

export function i18nFromMeta(meta: EfMeta | null | undefined): PageI18n {
    const lang = typeof meta?.language === 'string' ? meta.language.trim() : '';
    const of = typeof meta?.translation_of === 'string' ? meta.translation_of.trim() : '';
    return { language: lang === '' ? null : lang, translation_of: of === '' ? null : of };
}

export function applyI18nToMeta(meta: EfMeta, i18n: PageI18n): EfMeta {
    const out: EfMeta = { ...meta };
    if (i18n.language) out.language = i18n.language; else delete out.language;
    if (i18n.translation_of) out.translation_of = i18n.translation_of; else delete out.translation_of;
    return out;
}

export function baselineOf(entry: StateEntry | undefined): PageI18n | undefined {
    const raw = entry?.extra?.i18n as Partial<PageI18n> | undefined;
    if (!raw || typeof raw !== 'object') return undefined;
    return { language: raw.language ?? null, translation_of: raw.translation_of ?? null };
}

export function extraWithBaseline(prev: Record<string, unknown> | undefined, i18n: PageI18n | undefined): Record<string, unknown> | undefined {
    if (!i18n) return prev;
    return { ...(prev ?? {}), i18n: { language: i18n.language, translation_of: i18n.translation_of } };
}

/** What changed locally against the baseline, as page-settings fields still to resolve. */
export function i18nChanges(local: PageI18n, baseline: PageI18n): Partial<PageI18n> {
    const out: Partial<PageI18n> = {};
    if ((local.language ?? null) !== (baseline.language ?? null)) out.language = local.language;
    if ((local.translation_of ?? null) !== (baseline.translation_of ?? null)) out.translation_of = local.translation_of;
    return out;
}

/** Page-settings payload for a change: the source slug becomes `translation_source_id`. */
export async function i18nPayload(changes: Partial<PageI18n>, index: SlugIndex): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if ('language' in changes) out.language = changes.language ?? null;
    if ('translation_of' in changes) {
        out.translation_source_id = changes.translation_of ? await index.idOf(changes.translation_of) : null;
    }
    return out;
}

/** "--lang ro" / "--lang none" → normalized code or null. */
export function parseLangFlag(v: string): string | null {
    const t = v.trim();
    if (/^(none|null|-|)$/i.test(t)) return null;
    const code = t.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
    if (!/^[a-z][a-z0-9-]*$/.test(code)) {
        throw new CliError(ExitCode.Validation, `--lang takes a language code like "ro" or "pt-br", or "none" (got "${v}").`);
    }
    return code;
}

/** "--translation-of <slug>" / "none" → slug or null. */
export function parseTranslationOfFlag(v: string): string | null {
    const t = v.trim().replace(/^\/+/, '');
    return /^(none|null|-|)$/i.test(t) ? null : t;
}
