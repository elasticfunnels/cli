// Multilingual sites (T1031-3): page translations, brand languages, the brand dictionary and the brand's
// i18n settings. Every route is under /api/brands/{brand}/ with the caller's EF-Access-Key, so the app's
// page and translation policies apply exactly as in the web screens.
import { AxiosResponse } from 'axios';
import { ApiClient, httpError, validationError } from './client';
import { Component, Page } from './types';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function call<T>(api: ApiClient, method: Method, url: string, label: string, opts?: { params?: Record<string, unknown>; data?: unknown }): Promise<T> {
    const res = await api.request(method, url, opts);
    if (res.status === 422) throw validationError(label, normalize422(res));
    if (res.status >= 400) throw httpError(label, res);
    return res.data as T;
}

/** The translation controllers answer 422 with `errors: [{field, message}]`; Laravel requests with `errors: {field: [..]}`. */
function normalize422(res: AxiosResponse): AxiosResponse {
    const data = res.data as { errors?: unknown } | undefined;
    if (data && Array.isArray(data.errors)) {
        const errors: Record<string, string[]> = {};
        for (const e of data.errors as Array<{ field?: string; message?: string }>) {
            const k = e?.field ?? 'error';
            (errors[k] ??= []).push(String(e?.message ?? 'invalid'));
        }
        return { ...res, data: { ...(res.data as object), errors } };
    }
    return res;
}

function unwrap<T>(body: unknown, key: string): T {
    if (body && typeof body === 'object' && key in (body as Record<string, unknown>)) {
        return (body as Record<string, unknown>)[key] as T;
    }
    if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>) && !Array.isArray((body as Record<string, unknown>).data)) {
        return (body as Record<string, unknown>).data as T;
    }
    return body as T;
}

// ── Page translations ────────────────────────────────────────────────

export interface TranslationMember {
    id: number;
    slug: string | null;
    title: string | null;
    language: string | null;
    url?: string | null;
    status?: string | null;
    code?: string | null;
    name?: string | null;
    is_source: boolean;
    stale: boolean | null;
}

/** Pages and components share the translation routes: /pages/{id}/translations and /components/{id}/translations. */
export type TranslatableKind = 'page' | 'component';

function base(kind: TranslatableKind, brandId: number, id: number): string {
    return `/api/brands/${brandId}/${kind === 'page' ? 'pages' : 'components'}/${id}/translations`;
}

export async function listTranslations(api: ApiClient, brandId: number, kind: TranslatableKind, id: number): Promise<TranslationMember[]> {
    const body = await call<{ data?: TranslationMember[] } | TranslationMember[]>(api, 'GET', base(kind, brandId, id), 'List translations');
    return Array.isArray(body) ? body : (body.data ?? []);
}

/**
 * Clone the group's source into `language` and link it. Pages take `slug` / `title`
 * (default slug `<prefix>/<source slug>`); components take `code` / `name`.
 */
export async function createTranslation(
    api: ApiClient,
    brandId: number,
    kind: TranslatableKind,
    id: number,
    payload: { language: string; slug?: string; title?: string; code?: string; name?: string; copy_content?: boolean },
): Promise<Page & Component> {
    const body = await call<Record<string, unknown>>(api, 'POST', base(kind, brandId, id), 'Create translation', { data: payload });
    return createdFrom(kind, body);
}

/**
 * The app answers 201 `{ page_id | component_id, slug | code, language, translation_source_id, data: [group rows] }`.
 * A `{ page | component: {...} }` body is accepted too.
 */
export function createdFrom(_kind: TranslatableKind, body: Record<string, unknown> | null): Page & Component {
    const o = (body ?? {}) as Record<string, unknown>;
    const nested = (o.page ?? o.component ?? o.pageComponent) as Record<string, unknown> | undefined;
    const src = nested && typeof nested === 'object' ? nested : o;
    const newId = Number(src.id ?? o.page_id ?? o.component_id);
    const row = Array.isArray(o.data) ? (o.data as TranslationMember[]).find(m => m.id === newId) : undefined;
    return {
        ...(src as object),
        id: newId,
        slug: (src.slug as string | undefined) ?? row?.slug ?? null,
        code: (src.code as string | undefined) ?? row?.code ?? null,
        title: (src.title as string | undefined) ?? row?.title ?? null,
        name: (src.name as string | undefined) ?? row?.name ?? '',
        language: (src.language as string | undefined) ?? row?.language ?? null,
        translation_source_id: (src.translation_source_id as number | undefined) ?? null,
    } as Page & Component;
}

export async function markSynced(api: ApiClient, brandId: number, kind: TranslatableKind, id: number): Promise<unknown> {
    return await call<unknown>(api, 'POST', `${base(kind, brandId, id)}/synced`, 'Mark translation synced');
}

// ── Languages ────────────────────────────────────────────────────────

export interface TranslationLanguage {
    id: number;
    code: string;
    label: string | null;
    is_default: boolean;
    sort_order?: number | null;
    url_prefix?: string | null;
    effective_prefix?: string | null;
    entries_count?: number;
}

interface Paginated<T> { data?: T[]; current_page?: number; last_page?: number }

async function allPages<T>(api: ApiClient, url: string, label: string, perPage: number, params: Record<string, unknown> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 10000; page++) {
        const body = await call<Paginated<T> | T[]>(api, 'GET', url, label, { params: { ...params, per_page: perPage, page } });
        if (Array.isArray(body)) return body;
        out.push(...(body.data ?? []));
        const last = body.last_page ?? 1;
        if (page >= last || (body.data ?? []).length === 0) break;
    }
    return out;
}

export async function listLanguages(api: ApiClient, brandId: number): Promise<TranslationLanguage[]> {
    return await allPages<TranslationLanguage>(api, `/api/brands/${brandId}/translation-languages`, 'List languages', 100);
}

export async function createLanguage(api: ApiClient, brandId: number, payload: Partial<TranslationLanguage>): Promise<TranslationLanguage> {
    const body = await call<unknown>(api, 'POST', `/api/brands/${brandId}/translation-languages`, 'Create language', { data: payload });
    return unwrap<TranslationLanguage>(body, 'language');
}

export async function updateLanguage(api: ApiClient, brandId: number, id: number, payload: Partial<TranslationLanguage>): Promise<TranslationLanguage> {
    const body = await call<unknown>(api, 'PUT', `/api/brands/${brandId}/translation-languages/${id}`, 'Update language', { data: payload });
    return unwrap<TranslationLanguage>(body, 'language');
}

// ── Dictionary entries ───────────────────────────────────────────────

export interface TranslationEntry {
    id: number;
    key: string;
    value: string | null;
    brand_translation_language_id: number;
}

export async function listEntries(api: ApiClient, brandId: number, languageId: number): Promise<TranslationEntry[]> {
    return await allPages<TranslationEntry>(api, `/api/brands/${brandId}/translation-entries`, 'List texts', 200, { language_id: languageId });
}

/** The server caps one bulk request at 1000 rows. */
export const BULK_MAX = 1000;

export async function bulkSaveEntries(
    api: ApiClient,
    brandId: number,
    languageId: number,
    entries: Array<{ key: string; value: string }>,
): Promise<{ created: number; updated: number; skipped: number }> {
    const total = { created: 0, updated: 0, skipped: 0 };
    for (let i = 0; i < entries.length; i += BULK_MAX) {
        const chunk = entries.slice(i, i + BULK_MAX);
        const r = await call<{ created?: number; updated?: number; skipped?: number }>(
            api, 'POST', `/api/brands/${brandId}/translation-entries/bulk`, 'Save texts',
            { data: { brand_translation_language_id: languageId, entries: chunk } },
        );
        total.created += r.created ?? 0;
        total.updated += r.updated ?? 0;
        total.skipped += r.skipped ?? 0;
    }
    return total;
}

export async function deleteEntry(api: ApiClient, brandId: number, entryId: number): Promise<void> {
    await call<unknown>(api, 'DELETE', `/api/brands/${brandId}/translation-entries/${entryId}`, 'Delete text');
}

// ── Brand i18n settings ──────────────────────────────────────────────

export type PromptMode = 'off' | 'default' | 'custom';

export interface I18nSettings {
    prefix_routing: boolean;
    x_default: string | null;
    prompt: PromptMode;
}

function settingsFrom(body: unknown): I18nSettings {
    let o = body as Record<string, unknown> | null;
    if (o && typeof o === 'object' && o.i18n && typeof o.i18n === 'object') o = o.i18n as Record<string, unknown>;
    else if (o && typeof o === 'object' && o.data && typeof o.data === 'object') o = o.data as Record<string, unknown>;
    return {
        prefix_routing: Boolean(o?.prefix_routing),
        x_default: typeof o?.x_default === 'string' && o.x_default !== '' ? o.x_default : null,
        prompt: (o?.prompt === 'default' || o?.prompt === 'custom') ? o.prompt : 'off',
    };
}

export async function getI18nSettings(api: ApiClient, brandId: number): Promise<I18nSettings> {
    return settingsFrom(await call<unknown>(api, 'GET', `/api/brands/${brandId}/i18n-settings`, 'Read i18n settings'));
}

export async function putI18nSettings(api: ApiClient, brandId: number, settings: I18nSettings): Promise<I18nSettings> {
    return settingsFrom(await call<unknown>(api, 'PUT', `/api/brands/${brandId}/i18n-settings`, 'Save i18n settings', { data: settings }));
}

// ── Codes ────────────────────────────────────────────────────────────

/** Same normalization as the app's BrandTranslationLanguage::normalizeCode: lowercase, [a-z0-9-] only, 16 chars. */
export function normalizeLanguageCode(code: string): string {
    return code.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
}
