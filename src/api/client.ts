import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import {
    Asset,
    AssetEditorPayload,
    Automation,
    BackendScript,
    Brand,
    BrandDomain,
    BrandCollection,
    BrandCollectionField,
    BrandTag,
    BrandSeoConfig,
    BrandEmail,
    BrandTemplate,
    BrandTemplatePage,
    ClickRow,
    Component,
    ConversionRow,
    CrmEntity,
    CrmEntry,
    CrmField,
    CrmPipeline,
    CrmStage,
    DomainValidationInstructions,
    DomainMoveOptions,
    DomainMovePreview,
    DomainMoveResult,
    Funnel,
    FunnelDetails,
    Page,
    PageFolder,
    PageUpdateResponse,
    PageVariant,
    ShippingProfile,
    Paginated,
    Product,
    SessionDetails,
    SeoPage,
    AnalyticsCard,
    AnalyticsCardCatalog,
    AnalyticsMetricDef,
    AnalyticsMetricData,
    AnalyticsGroupRow,
    SplitTest,
    SplitTestNodeCode,
    SplitTestSignificance,
    DashboardConfig,
    DashboardPreset,
    FunnelResolveResult,
    ContactListPage,
    ContactDetail,
} from './types';
import { CliError, ExitCode, ExitCodeValue } from '../utils/exit';
import { requestStart, requestEnd } from '../utils/loader';

/** Max files the server's bulk-upload endpoint accepts per request. */
export const BULK_UPLOAD_MAX = 20;

/** Transient-failure retry policy (env-tunable, mainly for tests). */
const RETRY_MAX = Number(process.env.EF_RETRY_MAX ?? 4);
const RETRY_BASE_MS = Number(process.env.EF_RETRY_BASE_MS ?? 300);

/**
 * Which failures are safe to retry. Idempotent methods (GET/PUT/DELETE/PATCH)
 * retry on a network error, 5xx, or 429; a POST only retries on 429/503 (both
 * mean "not processed") so we never risk a double-create on an ambiguous error.
 */
function shouldRetry(method: string, status: number, hadResponse: boolean, attempt: number): boolean {
    if (attempt >= RETRY_MAX) return false;
    const idempotent = method !== 'POST';
    if (!hadResponse) return idempotent;                 // network drop / timeout
    if (status === 429 || status === 503) return true;   // rate-limited / unavailable
    if (status >= 500) return idempotent;                // other 5xx
    return false;
}

/** Backoff before a retry: exponential + jitter, honoring `Retry-After` (seconds). */
async function sleepForRetry(attempt: number, res?: AxiosResponse): Promise<void> {
    let ms = Math.min(8000, RETRY_BASE_MS * 2 ** attempt);
    const ra = res?.headers?.['retry-after'];
    if (ra != null) {
        const s = parseInt(String(ra), 10);
        if (Number.isFinite(s) && s >= 0) ms = Math.min(30000, s * 1000);
    }
    ms += Math.floor(Math.random() * ms * 0.25); // jitter to avoid thundering herds
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BulkUploadFileResult {
    filename: string;
    status: 'uploaded' | 'failed' | string;
    error?: string;
}

export interface BulkUploadResult {
    summary: { total: number; uploaded: number; failed: number };
    files: BulkUploadFileResult[];
}

/** Laravel index endpoints return either a bare array or a paginated { data: [...] }. */
function crmList<T>(data: unknown): T[] {
    if (Array.isArray(data)) return data as T[];
    const d = (data as { data?: unknown } | null)?.data;
    return Array.isArray(d) ? (d as T[]) : [];
}
/** Store/update endpoints may wrap the model under a key; unwrap the first that matches. */
function crmModel<T>(data: unknown, ...keys: string[]): T {
    const obj = data as Record<string, unknown> | null;
    if (obj) for (const k of keys) if (obj[k] && typeof obj[k] === 'object') return obj[k] as T;
    return data as T;
}

/**
 * Distilled, VS-Code-free copy of the API surface the extension uses.
 * Same endpoints, same payloads — so a file produced by the CLI and a
 * file produced by the extension are byte-identical for the same content.
 */
/**
 * Auth scheme for {@link ApiClient}. Structurally matches `EfAuth` in
 * `utils/store` (kept as its own type here to avoid a module cycle). Omitted →
 * `EF-Access-Key`, the human CLI's per-brand key. `bearer` sends
 * `Authorization: Bearer <key>` plus an optional `x-runner-id`, which is how a
 * brand-scoped agent token authenticates — the backend identifies the caller by
 * that runner id on every claim, event and completion.
 */
export interface ApiAuth {
    scheme?: 'ef-access-key' | 'bearer';
    runnerId?: string;
}

export class ApiClient {
    private http: AxiosInstance;
    constructor(public readonly apiUrl: string, public readonly apiKey: string, auth?: ApiAuth) {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': `ef-cli/${packageVersion()}`,
        };
        if (auth?.scheme === 'bearer') {
            headers['Authorization'] = `Bearer ${apiKey}`;
            if (auth.runnerId) headers['x-runner-id'] = auth.runnerId;
        } else {
            // Default path, byte-identical to before: omitting `auth` leaves every
            // existing caller on the EF-Access-Key header it already sent.
            headers['EF-Access-Key'] = apiKey;
        }
        this.http = axios.create({
            baseURL: apiUrl,
            timeout: 60000,
            headers,
            // Don't throw on >=400 inside the helper paths that want to inspect status; we
            // wrap normal calls in try/catch in callers.
            validateStatus: (s) => s >= 200 && s < 600,
        });
    }

    // ── Connection / brand discovery ─────────────────────────────────

    async ping(brandId: number): Promise<boolean> {
        return (await this.pingDetailed(brandId)).ok;
    }

    /**
     * `ping` with the status code kept.
     *
     * "Could not reach the brand" and "the server answered, and rejected your
     * credential" are different problems with different fixes, and collapsing
     * both to `false` made `ef status` report a revoked token as an unreachable
     * API — sending people to check their network instead of re-authenticating.
     */
    async pingDetailed(brandId: number): Promise<{ ok: boolean; status: number }> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/all`, { params: { type: 'editor' } });
        return { ok: res.status === 200, status: res.status };
    }

    /**
     * List all brands the authenticated user has access to. Used during
     * `ef init` so the user can pick from a real list instead of typing
     * a brand id by hand.
     */
    async listBrands(): Promise<Brand[]> {
        const res = await this.raw('GET', '/api/brands/all');
        if (res.status === 401 || res.status === 403) {
            // Deliberately says nothing about *which* kind of credential to go
            // fix: the dispatcher appends that, based on what is actually
            // stored. See utils/credential.ts.
            throw new CliError(ExitCode.Auth, `Credential was rejected by the server (HTTP ${res.status}).`);
        }
        if (res.status >= 400) throw httpError('List brands', res);
        const body = res.data as Brand[] | { data?: Brand[] };
        return Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data! : []);
    }

    // ── Pages ────────────────────────────────────────────────────────

    /**
     * `filters.tag` is applied by the SERVER (`PageFilter::tag`), so filtering
     * by tag costs the same one request as not filtering. Components have no
     * equivalent filter — see `commands/tags.ts` for why that surface differs.
     *
     * `type: 'editor'` is sent by default and is a real server filter
     * (`PageFilter::type` → `page_type = 'editor'`): only code-editor pages can
     * be synced as `.ef` files, so sync, slug resolution and `ef list pages`
     * deliberately see just those. Visual-builder pages and legacy pages
     * (`page_type` NULL) — which is most funnel steps on older brands — are
     * only returned with `allTypes: true`.
     */
    async listPages(brandId: number, limit = 10000, filters?: { tag?: string; allTypes?: boolean }): Promise<Page[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/all`, {
            params: {
                sort: 'title',
                ...(filters?.allTypes ? {} : { type: 'editor' }),
                ...(filters?.tag ? { tag: filters.tag } : {}),
            },
        });
        if (res.status >= 400) throw httpError('List pages', res);
        const arr = (Array.isArray(res.data) ? res.data : []) as Page[];
        return arr.slice(0, limit);
    }

    async getPageContent(brandId: number, pageId: number, opts?: { published?: boolean }): Promise<Page> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/${pageId}/editor`, {
            params: opts?.published ? { published: true } : {},
        });
        if (res.status >= 400) throw httpError('Get page content', res);
        return res.data as Page;
    }

    async updatePageHtml(
        brandId: number,
        pageId: number,
        html: string,
        opts: {
            draft?: boolean;
            revisionId?: number | null;
            expectedRevisionId?: number | null;
            autoCreateCollections?: boolean;
        } = {},
    ): Promise<PageUpdateResponse> {
        const body = {
            html,
            draft: !!opts.draft,
            ...(opts.revisionId != null ? { revision_id: opts.revisionId } : {}),
            ...(opts.expectedRevisionId != null ? { expected_revision_id: opts.expectedRevisionId } : {}),
            ...(opts.autoCreateCollections ? { auto_create_collections: true } : {}),
        };
        const res = await this.raw('POST', `/api/brands/${brandId}/pages/${pageId}/editor`, { data: body });
        if (res.status === 409) {
            throw new CliError(
                ExitCode.Conflict,
                buildRevisionConflictMessage(res.data as PageUpdateResponse),
            );
        }
        if (res.status >= 400) throw httpError('Update page', res);
        return res.data as PageUpdateResponse;
    }

    async createPage(brandId: number, title: string, slug?: string, folderId?: number): Promise<Page> {
        const res = await this.raw('POST', `/api/brands/${brandId}/pages`, {
            data: {
                title,
                ...(slug ? { slug } : {}),
                ...(folderId != null ? { folder_id: folderId } : {}),
                page_type: 'editor',
            },
        });
        if (res.status >= 400) throw httpError('Create page', res);
        const body = res.data as { page?: Page } | Page;
        return ('page' in body && body.page ? body.page : body) as Page;
    }

    async duplicatePage(brandId: number, pageId: number): Promise<Page> {
        const res = await this.raw('POST', `/api/brands/${brandId}/pages/${pageId}/duplicate`);
        if (res.status === 404) {
            // Fallback: not all backends expose a duplicate endpoint; mimic via
            // get + create. Caller can wrap if needed. We surface a clear error.
            throw new CliError(ExitCode.NotFound, `Duplicate endpoint not available for page #${pageId} on this server.`);
        }
        if (res.status >= 400) throw httpError('Duplicate page', res);
        const body = res.data as { page?: Page } | Page;
        return ('page' in body && body.page ? body.page : body) as Page;
    }

    async deletePage(brandId: number, pageId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/pages/${pageId}`);
        if (res.status >= 400) throw httpError('Delete page', res);
    }

    /**
     * Update a page's settings (title, slug, domain, folder, status, SEO, …)
     * via the page resource — distinct from {@link updatePageHtml}, which only
     * touches editor HTML. `title` is always required by the server, so callers
     * must include it (the CLI fills it from the current page when omitted).
     */
    async updatePageSettings(brandId: number, pageId: number, settings: Record<string, unknown>): Promise<Page> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/pages/${pageId}`, { data: settings });
        if (res.status === 422) throw validationError('Page settings', res);
        if (res.status >= 400) throw httpError('Update page settings', res);
        const body = res.data as { page?: Page } | Page;
        return ('page' in body && body.page ? body.page : body) as Page;
    }

    // ── Page variants (whole-page split tests) ───────────────────────
    // Variants are siblings of a parent page, not copies: they share the
    // family and take traffic under one URL. Creating one returns only the new
    // page id, so callers read the assigned slug back via listVariants.

    /**
     * Add a variant to `pageId`'s family. `fromActive` seeds it from whichever
     * sibling currently serves traffic rather than from the parent — which is
     * what you want when the parent is stale and the live variant is the real
     * baseline.
     */
    async createPageVariant(brandId: number, pageId: number, opts?: { fromActive?: boolean }): Promise<{ page_id: number }> {
        const res = await this.raw('POST', `/api/brands/${brandId}/pages/${pageId}/page-variant`, {
            data: opts?.fromActive ? { from_active: true } : {},
        });
        if (res.status >= 400) throw httpError('Create page variant', res);
        return res.data as { page_id: number };
    }

    /** Add a variant seeded from one specific sibling, named explicitly. */
    async createVariantFromVariant(brandId: number, pageId: number, sourceVariantId: number): Promise<{ page_id: number }> {
        const res = await this.raw('POST', `/api/brands/${brandId}/pages/${pageId}/create-variant`, {
            data: { source_variant_id: sourceVariantId },
        });
        if (res.status >= 400) throw httpError('Create variant from variant', res);
        return res.data as { page_id: number };
    }

    /**
     * List a page's variant family. `showAll` includes archived/inactive rows;
     * without it you get the family as it currently serves. `current_page_id`
     * falls back to the requested id so callers always have an anchor.
     */
    async listVariants(brandId: number, pageId: number, opts?: { showAll?: boolean }): Promise<{ variants: PageVariant[]; current_page_id: number }> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/${pageId}/variants`, {
            params: opts?.showAll ? { show_all: 1 } : {},
        });
        if (res.status >= 400) throw httpError('List variants', res);
        const body = res.data as { variants?: PageVariant[]; current_page_id?: number };
        return { variants: Array.isArray(body.variants) ? body.variants : [], current_page_id: body.current_page_id ?? pageId };
    }

    async listPageFolders(brandId: number): Promise<PageFolder[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/page-folders`);
        if (res.status === 403) return [];
        if (res.status >= 400) throw httpError('List page folders', res);
        return (Array.isArray(res.data) ? res.data : []) as PageFolder[];
    }

    /**
     * The brand's folder tree (roots with nested `children`). Unlike
     * `listPageFolders`, a brand with folders switched off is an error here,
     * so `ef folders` can say so instead of printing an empty list.
     */
    async getPageFolderTree(brandId: number): Promise<PageFolder[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/page-folders`);
        if (res.status === 403) {
            throw new CliError(ExitCode.Validation, 'Folders are switched off for this brand. Turn on "Page folders" in the brand settings in the app, then retry.');
        }
        if (res.status >= 400) throw httpError('List page folders', res);
        return (Array.isArray(res.data) ? res.data : []) as PageFolder[];
    }

    async createPageFolder(brandId: number, payload: { name: string; parent_id?: number | null; color?: string; order?: number }): Promise<PageFolder> {
        const res = await this.raw('POST', `/api/brands/${brandId}/page-folders`, { data: payload });
        if (res.status >= 400) throw httpError('Create folder', res);
        return ((res.data as { folder?: PageFolder })?.folder ?? res.data) as PageFolder;
    }

    async updatePageFolder(brandId: number, folderId: number, payload: { name?: string; parent_id?: number | null; color?: string | null; order?: number }): Promise<PageFolder> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/page-folders/${folderId}`, { data: payload });
        if (res.status >= 400) throw httpError('Update folder', res);
        return ((res.data as { folder?: PageFolder })?.folder ?? res.data) as PageFolder;
    }

    /** Pages in the folder fall back to "no folder"; subfolders move up one level. */
    async deletePageFolder(brandId: number, folderId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/page-folders/${folderId}`);
        if (res.status >= 400) throw httpError('Delete folder', res);
    }

    /**
     * File pages into a folder (null = no folder). The endpoint writes only
     * `folder_id`, so slug, status, domain and funnel wiring are untouched,
     * which is why bulk filing goes through here and not the settings PUT.
     */
    async movePagesToFolder(brandId: number, pageIds: number[], folderId: number | null): Promise<number> {
        const res = await this.raw('POST', `/api/brands/${brandId}/pages/bulk-move-to-folder`, {
            data: { page_ids: pageIds, folder_id: folderId },
        });
        if (res.status >= 400) throw httpError('Move pages to folder', res);
        return Number((res.data as { moved_count?: number })?.moved_count ?? pageIds.length);
    }

    async getPagesSyncDelta(brandId: number, updatedAfter?: string | null): Promise<Array<{
        id: number; slug: string | null; variant_slug?: string | null; status?: string;
        domain?: string | null; updated_at?: string;
    }>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/sync-delta`, {
            params: updatedAfter ? { updated_after: updatedAfter } : {},
        });
        if (res.status >= 400) throw httpError('Get pages sync-delta', res);
        return Array.isArray(res.data) ? res.data : [];
    }

    async getPreviewUrl(brandId: number, pageId: number, revisionId?: number | null): Promise<string> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/${pageId}/editor/preview-url`, {
            params: revisionId != null ? { revision_id: revisionId } : {},
        });
        if (res.status >= 400) throw httpError('Get preview URL', res);
        const url = (res.data as { url?: string | null })?.url;
        if (!url) throw new CliError(ExitCode.Server, 'Server did not return a preview URL.');
        return url;
    }

    async getLiveUrl(brandId: number, pageId: number): Promise<string | null> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/${pageId}/editor/live-url`);
        if (res.status === 404) return null;
        if (res.status >= 400) throw httpError('Get live URL', res);
        return (res.data as { url?: string | null })?.url ?? null;
    }

    // ── Page events (funnel builder graph: split tests, redirects, tags, popups) ──

    /** The Drawflow graph for a page, or null when the page has no events yet
     *  (the server returns an empty 200). */
    async getPageEvents(brandId: number, pageId: number): Promise<Record<string, unknown> | null> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/${pageId}/events`);
        if (res.status === 404) return null;
        if (res.status >= 400) throw httpError('Get page events', res);
        const data = res.data;
        if (!data || (typeof data === 'string' && data.trim() === '')) return null;
        if (typeof data !== 'object' || Array.isArray(data)) return null;
        return Object.keys(data as object).length === 0 ? null : (data as Record<string, unknown>);
    }

    /** Save the Drawflow graph (server normalizes it: render envelope, positions,
     *  split-test node ids). */
    async setPageEvents(brandId: number, pageId: number, graph: unknown): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/pages/${pageId}/events`, { data: graph });
        if (res.status >= 400) throw httpError('Save page events', res);
    }

    /** Validate a graph (or, with an empty body, the stored one). `strict` makes
     *  the server reject rather than warn. Returns the validator's report. */
    async validatePageEvents(brandId: number, pageId: number, graph?: unknown, strict?: boolean): Promise<unknown> {
        const res = await this.raw('POST', `/api/brands/${brandId}/pages/${pageId}/events/validate`, {
            data: graph ?? {},
            params: strict ? { strict_validation: 1 } : {},
        });
        if (res.status >= 400) throw httpError('Validate page events', res);
        return res.data;
    }

    /** The event-node vocabulary (valid node types + connection rules). */
    async getPageEventsVocabulary(brandId: number, pageId: number): Promise<unknown> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/${pageId}/events/node-vocabulary`);
        if (res.status >= 400) throw httpError('Get page events vocabulary', res);
        return res.data;
    }

    // ── Funnels ──────────────────────────────────────────────────────
    // The editable graph is `config` (Drawflow) via /builder; flow/product_flow/
    // variant_seeds are read-only artifacts regenerated on every save.

    /**
     * Funnel ids that are the DEFAULT on `domainId` (paginated `GET funnels`,
     * which carries each funnel's domain assignments; `funnels/all` does not).
     */
    async defaultFunnelsOnDomain(brandId: number, domainId: number): Promise<number[]> {
        const out: number[] = [];
        for (let page = 1; page <= 50; page++) {
            const res = await this.raw('GET', `/api/brands/${brandId}/funnels`, { params: { per_page: 100, page } });
            if (res.status >= 400) throw httpError('List funnels', res);
            const body = res.data as { data?: Array<{ id: number; domains?: Array<{ domain_id: number; is_default?: boolean | number }> }>; last_page?: number };
            for (const f of body.data ?? []) {
                if ((f.domains ?? []).some((d) => Number(d.domain_id) === domainId && Boolean(d.is_default))) out.push(Number(f.id));
            }
            if (!body.last_page || page >= body.last_page) break;
        }
        return out;
    }

    async listFunnels(brandId: number): Promise<Funnel[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/funnels/all`);
        if (res.status === 403 || res.status === 404) return [];
        if (res.status >= 400) throw httpError('List funnels', res);
        const body = res.data;
        if (Array.isArray(body)) return body as Funnel[];
        const d = (body as { data?: Funnel[] }).data;
        return Array.isArray(d) ? d : [];
    }

    async createFunnel(brandId: number, meta: Record<string, unknown>): Promise<Funnel> {
        const res = await this.raw('POST', `/api/brands/${brandId}/funnels`, { data: meta });
        if (res.status >= 400) throw httpError('Create funnel', res);
        const body = res.data as { funnel?: Funnel };
        return body.funnel ?? (res.data as Funnel);
    }

    /** One funnel's settings (`GET funnels/{id}?flow=0` — the compiled flow is left out). */
    async getFunnel(brandId: number, id: number): Promise<FunnelDetails> {
        const res = await this.raw('GET', `/api/brands/${brandId}/funnels/${id}`, { params: { flow: 0 } });
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Funnel #${id} not found in this brand.`);
        if (res.status >= 400) throw httpError('Get funnel', res);
        return res.data as FunnelDetails;
    }

    /**
     * `PUT funnels/{id}` (FunnelsController::update, SaveFunnel). NOT a partial
     * update: `title` is always required, `domains` is required unless the
     * status sent is `draft` and is replaced wholesale when present, and `rules`
     * is overwritten with null when absent. Callers send the full current
     * settings — see `buildFunnelUpdatePayload` in commands/funnels.ts.
     */
    async updateFunnel(brandId: number, id: number, payload: Record<string, unknown>): Promise<FunnelDetails> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/funnels/${id}`, { data: payload });
        if (res.status === 422) throw validationError('Funnel settings', res);
        if (res.status >= 400) throw httpError('Update funnel', res);
        const body = res.data as { funnel?: FunnelDetails } | FunnelDetails;
        return ('funnel' in body && body.funnel ? body.funnel : body) as FunnelDetails;
    }

    async deleteFunnel(brandId: number, id: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/funnels/${id}`);
        if (res.status >= 400) throw httpError('Delete funnel', res);
    }

    /** The editable Drawflow graph (`config`), or null when unset. */
    async getFunnelBuilder(brandId: number, id: number): Promise<Record<string, unknown> | null> {
        const res = await this.raw('GET', `/api/brands/${brandId}/funnels/${id}/builder`);
        if (res.status === 404) return null;
        if (res.status >= 400) throw httpError('Get funnel builder', res);
        const data = res.data;
        if (!data || (typeof data === 'string' && data.trim() === '')) return null;
        if (typeof data !== 'object' || Array.isArray(data)) return null;
        return Object.keys(data as object).length === 0 ? null : (data as Record<string, unknown>);
    }

    async setFunnelBuilder(brandId: number, id: number, graph: unknown): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/funnels/${id}/builder`, { data: graph });
        if (res.status >= 400) throw httpError('Save funnel builder', res);
    }

    /** Dry-run lint of a funnel builder graph. Empty body validates the stored graph. */
    async validateFunnelBuilder(brandId: number, id: number, graph?: unknown): Promise<unknown> {
        const res = await this.raw('POST', `/api/brands/${brandId}/funnels/${id}/builder/validate`, { data: graph ?? {} });
        if (res.status >= 400) throw httpError('Validate funnel builder', res);
        return res.data;
    }

    async getFunnelDebugFlow(brandId: number, id: number): Promise<unknown> {
        const res = await this.raw('GET', `/api/brands/${brandId}/funnels/${id}/debug-flow`);
        if (res.status >= 400) throw httpError('Get funnel debug-flow', res);
        return res.data;
    }

    async getFunnelProductFlow(brandId: number, id: number): Promise<unknown> {
        const res = await this.raw('GET', `/api/brands/${brandId}/funnels/${id}/debug-product-flow`);
        if (res.status >= 400) throw httpError('Get funnel product-flow', res);
        return res.data;
    }

    /**
     * The funnels list's "Which funnel runs?" tester (FunnelTriggerController@resolveTest).
     * Read only: the app sends a real request to the URL with a resolve-and-report header,
     * so affiliate, query, host and path come from the URL itself. Only geo is passed.
     */
    async resolveFunnelTest(brandId: number, body: { url: string; country_code?: string | null; region?: string | null }): Promise<FunnelResolveResult> {
        const res = await this.raw('POST', `/api/brands/${brandId}/funnels/resolve-test`, { data: body });
        if (res.status < 400) return res.data as FunnelResolveResult;
        const data = res.data as { error?: string; host?: string } | undefined;
        const label = 'Funnel resolve test';
        if (res.status === 404) {
            throw new CliError(ExitCode.NotFound, `${label}: this server has no "which funnel runs" tester (POST funnels/resolve-test). The app may be older than this CLI.`);
        }
        if (res.status === 422 && data?.error === 'foreign_domain') {
            throw new CliError(ExitCode.Validation, `${label}: ${data.host ?? 'that host'} is not one of this brand's domains. Run "ef domains list".`);
        }
        if (res.status === 422 && data?.error === 'malformed_url') {
            throw new CliError(ExitCode.Validation, `${label}: the server could not parse that URL.`);
        }
        if (res.status === 422) throw validationError(label, res);
        if (data?.error === 'runtime_not_configured') {
            throw new CliError(ExitCode.Server, `${label}: the page runtime is not configured on this server, so the test cannot run.`);
        }
        if (data?.error === 'runtime_unreachable') {
            throw new CliError(ExitCode.Server, `${label}: the app could not reach the page runtime. Try again in a minute.`);
        }
        throw httpError(label, res);
    }

    // ── Components ───────────────────────────────────────────────────

    async listComponents(brandId: number): Promise<Component[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/components/all`, {
            params: { type: 'editor' },
        });
        if (res.status >= 400) throw httpError('List components', res);
        return (Array.isArray(res.data) ? res.data : []) as Component[];
    }

    async getComponentContent(brandId: number, componentId: number, opts?: { published?: boolean }): Promise<Component> {
        const res = await this.raw('GET', `/api/brands/${brandId}/components/${componentId}/editor`, {
            params: opts?.published ? { published: true } : {},
        });
        if (res.status >= 400) throw httpError('Get component content', res);
        return res.data as Component;
    }

    /**
     * Component preview URL. Unlike pages (which expose a JSON preview-url
     * endpoint), the component route 302-redirects to the public render URL, so
     * we stop axios following it and read the `Location` header instead.
     */
    async getComponentPreviewUrl(brandId: number, idOrCode: number | string, revisionId?: number | null): Promise<string> {
        let res: AxiosResponse;
        try {
            res = await this.http.request({
                method: 'GET',
                url: `/api/brands/${brandId}/components/${encodeURIComponent(String(idOrCode))}/preview`,
                params: revisionId != null ? { revision_id: revisionId } : {},
                maxRedirects: 0,
                validateStatus: () => true,
            });
        } catch (err) {
            // Some axios/follow-redirects versions throw on a blocked redirect but
            // attach the response; recover the Location from it.
            const r = (err as { response?: AxiosResponse }).response;
            if (!r) throw err;
            res = r;
        }
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Component "${idOrCode}" not found.`);
        const headers = (res.headers ?? {}) as Record<string, string>;
        const location = headers.location ?? headers.Location;
        if (location) return location;
        const body = res.data as { preview_url?: string; url?: string } | undefined;
        if (body?.preview_url) return body.preview_url;
        if (body?.url) return body.url;
        if (res.status >= 400) throw httpError('Get component preview URL', res);
        throw new CliError(ExitCode.Server, 'Server did not return a component preview URL.');
    }

    async createComponent(brandId: number, name: string, html = '', code = ''): Promise<Component> {
        const res = await this.raw('POST', `/api/brands/${brandId}/components`, {
            data: { name, code, html, type: 'editor' },
        });
        if (res.status >= 400) throw httpError('Create component', res);
        const body = res.data as { pageComponent?: Component } | Component;
        return ('pageComponent' in body && body.pageComponent ? body.pageComponent : body) as Component;
    }

    async updateComponentHtml(
        brandId: number,
        componentId: number,
        html: string,
        opts: { draft?: boolean; revisionId?: number | null; expectedRevisionId?: number | null } = {},
    ): Promise<{ success: boolean; revision_id?: number }> {
        const body = {
            html,
            draft: !!opts.draft,
            ...(opts.revisionId != null ? { revision_id: opts.revisionId } : {}),
            ...(opts.expectedRevisionId != null ? { expected_revision_id: opts.expectedRevisionId } : {}),
        };
        const res = await this.raw('POST', `/api/brands/${brandId}/components/${componentId}/editor`, { data: body });
        if (res.status === 409) {
            throw new CliError(ExitCode.Conflict, buildRevisionConflictMessage(res.data as PageUpdateResponse));
        }
        if (res.status >= 400) throw httpError('Update component', res);
        return res.data as { success: boolean; revision_id?: number };
    }

    async deleteComponent(brandId: number, componentId: number, opts?: { force?: boolean }): Promise<void> {
        const url = opts?.force
            ? `/api/brands/${brandId}/components/${componentId}?force=1`
            : `/api/brands/${brandId}/components/${componentId}`;
        const res = await this.raw('DELETE', url);
        if (res.status >= 400) throw httpError('Delete component', res);
    }

    // ── Products ─────────────────────────────────────────────────────

    async listProducts(brandId: number, filters?: Record<string, string | number>): Promise<Product[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/products/all`, {
            params: filters ?? {},
        });
        if (res.status === 403) {
            throw new CliError(ExitCode.Auth, 'Products module is not enabled for this brand (or the API key lacks access).');
        }
        if (res.status >= 400) throw httpError('List products', res);
        const body = res.data as Product[] | { data?: Product[] };
        return Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data! : []);
    }

    async getProduct(brandId: number, productId: number): Promise<Product> {
        const res = await this.raw('GET', `/api/brands/${brandId}/products/${productId}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Product #${productId} not found.`);
        if (res.status >= 400) throw httpError('Get product', res);
        const body = res.data as { product?: Product } | Product;
        return ('product' in body && body.product ? body.product : body) as Product;
    }

    /**
     * Build request options for a product create/update. With an image, the
     * request is sent as multipart/form-data (the only way the server accepts a
     * product image — the JSON `image`/`image_link` field is read-only and
     * ignored). Without one, it's a plain JSON body.
     */
    private productRequestOpts(payload: Record<string, unknown>, image?: ProductImageUpload): { data: unknown; headers?: Record<string, string> } {
        if (!image) return { data: payload };
        const boundary = `----ElasticFunnelsCli${Date.now().toString(16)}`;
        return {
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            data: buildProductMultipartBody(boundary, payload, image),
        };
    }

    async createProduct(brandId: number, payload: Record<string, unknown>, image?: ProductImageUpload): Promise<Product> {
        const res = await this.raw('POST', `/api/brands/${brandId}/products`, this.productRequestOpts(payload, image));
        if (res.status === 403) throw planOrAuthError('Create product', res);
        if (res.status >= 400) throw httpError('Create product', res);
        const body = res.data as { product?: Product } | Product;
        return ('product' in body && body.product ? body.product : body) as Product;
    }

    /** Update is a POST (not PUT) on this resource — matches the dashboard. */
    async updateProduct(brandId: number, productId: number, payload: Record<string, unknown>, image?: ProductImageUpload): Promise<Product> {
        const res = await this.raw('POST', `/api/brands/${brandId}/products/${productId}`, this.productRequestOpts(payload, image));
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Product #${productId} not found.`);
        if (res.status >= 400) throw httpError('Update product', res);
        const body = res.data as { product?: Product } | Product;
        return ('product' in body && body.product ? body.product : body) as Product;
    }

    async deleteProduct(brandId: number, productId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/products/${productId}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Product #${productId} not found.`);
        if (res.status >= 400) throw httpError('Delete product', res);
    }

    async cloneProduct(brandId: number, productId: number): Promise<Product> {
        const res = await this.raw('POST', `/api/brands/${brandId}/products/${productId}/clone`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Product #${productId} not found.`);
        if (res.status >= 400) throw httpError('Clone product', res);
        const body = res.data as { product?: Product } | Product;
        return ('product' in body && body.product ? body.product : body) as Product;
    }

    // ── Variables ────────────────────────────────────────────────────

    async getBrandVariables(brandId: number): Promise<Record<string, unknown>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/variables`);
        if (res.status >= 400) throw httpError('Get brand variables', res);
        const body = res.data as { variables?: Record<string, unknown> | string };
        if (!body || body.variables == null) return {};
        if (typeof body.variables === 'string') {
            try { return JSON.parse(body.variables) as Record<string, unknown>; } catch { return {}; }
        }
        return body.variables;
    }

    async setBrandVariables(brandId: number, variables: Record<string, unknown>): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/variables`, {
            data: { variables: JSON.stringify(variables ?? {}) },
        });
        if (res.status >= 400) throw httpError('Set brand variables', res);
    }

    // ── SEO / discovery files ────────────────────────────────────────

    /** Brand-level sitemap.xml / llms.txt / robots.txt settings. */
    async getBrandSeo(brandId: number): Promise<BrandSeoConfig> {
        const res = await this.raw('GET', `/api/brands/${brandId}/seo`);
        if (res.status >= 400) throw httpError('Get SEO settings', res);
        const body = res.data as { data?: BrandSeoConfig } | BrandSeoConfig;
        const data = ('data' in body && body.data ? body.data : body) as BrandSeoConfig;
        return {
            sitemap_enabled: Boolean(data?.sitemap_enabled),
            llms_enabled: Boolean(data?.llms_enabled),
            robots_enabled: Boolean(data?.robots_enabled),
            site_name: data?.site_name ?? null,
            site_name_effective: data?.site_name_effective ?? null,
            site_summary: data?.site_summary ?? null,
            llms_notes: data?.llms_notes ?? null,
            robots_extra: data?.robots_extra ?? null,
        };
    }

    /**
     * Patch the SEO settings. The server merges into the stored bag, so a
     * partial payload changes only the keys it names.
     */
    async setBrandSeo(brandId: number, patch: Record<string, unknown>): Promise<BrandSeoConfig> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/seo`, { data: patch });
        if (res.status >= 400) throw httpError('Update SEO settings', res);
        const body = res.data as { seo_config?: BrandSeoConfig };
        return (body?.seo_config ?? {}) as BrandSeoConfig;
    }

    /** The pages currently listed in this brand's discovery files. */
    async listSeoPages(brandId: number): Promise<SeoPage[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/seo/pages`);
        if (res.status >= 400) throw httpError('List SEO pages', res);
        const body = res.data as SeoPage[] | { data?: SeoPage[] };
        return Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data! : []);
    }

    // ── Analytics ────────────────────────────────────────────────────

    /**
     * The metric registry this brand can actually read.
     *
     * Not a constant, and deliberately not baked into the CLI: the list is
     * assembled server-side per request from the brand's plan modules, the
     * caller's role permissions and a hidden-groups gate. Two brands on the
     * same release see different metrics, so `ef stats` discovers them rather
     * than shipping a list that would rot or lie.
     */
    async listAnalyticsMetrics(brandId: number, opts?: { splitTests?: boolean }): Promise<AnalyticsMetricDef[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/analytics/metrics`, {
            // The endpoint switches registries on the presence of the key, not
            // its value — it filters to split-test-capable metrics when asked.
            params: opts?.splitTests ? { split_test_id: 0 } : {},
        });
        if (res.status >= 400) throw httpError('List analytics metrics', res);
        const body = res.data as Record<string, AnalyticsMetricDef> | AnalyticsMetricDef[];
        if (Array.isArray(body)) return body;
        return Object.entries(body ?? {}).map(([type, def]) => ({ ...def, type: def.type ?? type }));
    }

    /**
     * The card catalog: which dashboard cards exist, and which report scopes
     * each one can resolve in.
     *
     * Discovered for the same reason the metric registry is — the server has
     * already dropped the cards this brand has no integration for and the ones
     * this key's role may not read, so two brands legitimately see different
     * lists. `scope` narrows it to the cards that can answer for one page /
     * funnel / split test; the vocabulary comes back in the response rather than
     * being spelled out here, so a new scope needs no CLI release.
     */
    async listAnalyticsCards(brandId: number, opts?: { scope?: string }): Promise<AnalyticsCardCatalog> {
        const res = await this.raw('GET', `/api/brands/${brandId}/analytics/cards`, {
            params: opts?.scope ? { scope: opts.scope } : {},
        });
        // The server answers an unknown scope with the list of real ones. Passing
        // that through beats a bare "422": the caller mistyped a name and the
        // reply already holds the correction.
        if (res.status === 422) {
            const body = res.data as { message?: string; scopes?: string[] };
            const known = Array.isArray(body?.scopes) && body.scopes.length
                ? ` Valid scopes: ${body.scopes.join(', ')}.`
                : '';
            throw new CliError(ExitCode.Validation, `${body?.message ?? 'Unknown scope.'}${known}`);
        }
        // The catalog endpoint is newer than the rest of the analytics surface,
        // so a brand on an older server has every other `ef stats` command
        // working and only this one missing. Say that, instead of reporting a
        // bare 404 that reads like a broken CLI or a bad brand id.
        if (res.status === 404) {
            throw new CliError(
                ExitCode.NotFound,
                'This ElasticFunnels server does not expose the card catalog yet — it needs a newer server release. Every other "ef stats" command works without it.',
            );
        }
        if (res.status >= 400) throw httpError('List analytics cards', res);
        const body = res.data as {
            data?: AnalyticsCard[];
            categories?: Record<string, string>;
            scopes?: string[];
            scope?: string | null;
        };
        return {
            cards: Array.isArray(body?.data) ? body.data : [],
            categories: body?.categories ?? {},
            scopes: Array.isArray(body?.scopes) ? body.scopes : [],
            scope: body?.scope ?? null,
        };
    }

    /**
     * Metric values for a date range.
     *
     * Note the response can carry metrics you did not ask for: `MetricResolver`
     * pulls in whatever a requested metric is computed from (asking for
     * `conversion_rate` also returns `sessions` and `customers`). Callers that
     * want exactly their selection have to filter it back down.
     */
    async getAnalyticsMetrics(
        brandId: number,
        opts: AnalyticsQuery & { metrics: string[] },
    ): Promise<AnalyticsMetricData> {
        const res = await this.raw('GET', `/api/brands/${brandId}/analytics/metrics/data`, {
            // This endpoint accepts a comma string; the grouped one below insists
            // on an array. Same subsystem, two conventions — absorbed here so no
            // command has to know.
            params: { ...analyticsParams(opts), selected_metrics: opts.metrics.join(',') },
        });
        if (res.status >= 400) throw httpError('Read analytics metrics', res);
        return (res.data ?? {}) as AnalyticsMetricData;
    }

    /**
     * The same metrics, broken down by one dimension (page, product, country,
     * utm_source, day, …). `listAnalyticsGroupingFields` enumerates what is
     * groupable for this brand.
     */
    async getAnalyticsGrouped(
        brandId: number,
        field: string,
        opts: AnalyticsQuery & { metrics: string[] },
    ): Promise<AnalyticsGroupRow[]> {
        const params: Record<string, unknown> = { ...analyticsParams(opts), 'selected_metrics[]': opts.metrics };
        // The grouped endpoint scopes by page only through its filter pipeline
        // (`filter[page_id]`, PageFilter); a bare `page_id` — which the summary
        // endpoint honours — is silently ignored here and returns brand-wide rows.
        // Send both until the server accepts `page_id` on this route too.
        if (opts.pageId != null) params['filter[page_id]'] = opts.pageId;
        const res = await this.raw('GET', `/api/brands/${brandId}/analytics/metrics/${encodeGroupField(field)}/data`, {
            // Array form is mandatory here — a comma string is rejected 422.
            params,
        });
        if (res.status >= 400) throw httpError(`Read analytics grouped by ${field}`, res);
        return normalizeGroupRows(res.data);
    }

    /** Which dimensions this brand may group by, keyed by category. */
    async listAnalyticsGroupingFields(brandId: number): Promise<Record<string, { name: string; fields: Record<string, { name: string; description?: string }> }>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/analytics/reports/grouping-fields`);
        if (res.status >= 400) throw httpError('List grouping fields', res);
        return (res.data ?? {}) as Record<string, { name: string; fields: Record<string, { name: string; description?: string }> }>;
    }

    // ── Split tests ──────────────────────────────────────────────────

    async listSplitTests(brandId: number, params?: Record<string, unknown>): Promise<SplitTest[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/split-tests`, {
            params: { per_page: 100, ...params },
        });
        if (res.status >= 400) throw httpError('List split tests', res);
        const body = res.data as SplitTest[] | { data?: SplitTest[] };
        return Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data! : []);
    }

    async getSplitTest(brandId: number, splitTestId: number): Promise<SplitTest> {
        const res = await this.raw('GET', `/api/brands/${brandId}/split-tests/${splitTestId}`);
        if (res.status >= 400) throw httpError('Get split test', res);
        const body = res.data as { data?: SplitTest } | SplitTest;
        return ((body as { data?: SplitTest })?.data ?? body) as SplitTest;
    }

    /**
     * The arms of a test as the graph names them: `{code, name}` per variant,
     * where `code` is the node_code the runtime buckets visitors by. This is the
     * only place a variant's display name is tied to the code a winner is
     * declared with.
     */
    async getSplitTestNodeCodes(brandId: number, splitTestId: number): Promise<SplitTestNodeCode[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/split-tests/${splitTestId}/node-codes`);
        if (res.status >= 400) throw httpError('Read split test variants', res);
        const body = res.data as SplitTestNodeCode[] | { data?: SplitTestNodeCode[]; node_codes?: SplitTestNodeCode[] };
        if (Array.isArray(body)) return body;
        return body?.node_codes ?? body?.data ?? [];
    }

    /**
     * Finalize a test on one arm.
     *
     * Goes through the programmatic endpoint on purpose. The dashboard's
     * `split-tests/{id}/declare-winner` only stamps the test row; the runtime
     * buckets traffic off `winner_node_code` in the page/funnel graph, which
     * that route never writes, so traffic would keep splitting under a test
     * marked finalized. This one writes the winner into the graph as well.
     */
    async declareSplitTestWinner(brandId: number, splitTestId: number, winnerNodeCode: string): Promise<SplitTest> {
        const res = await this.raw('POST', `/api/brands/${brandId}/programmatic-split-tests/${splitTestId}/declare-winner`, {
            data: { winner_node_code: winnerNodeCode },
        });
        if (res.status >= 400) throw httpError('Declare split test winner', res);
        const body = res.data as { data?: SplitTest } | SplitTest;
        return ((body as { data?: SplitTest })?.data ?? body) as SplitTest;
    }

    /**
     * The server's own significance verdict for a test.
     *
     * Read, never recomputed. The backend corrects alpha for the number of
     * arms and withholds a winner until every arm clears a power-based sample
     * floor; a second implementation here would eventually disagree with the
     * dashboard, and the disagreement would surface as "the CLI says we won".
     */
    async getSplitTestSignificance(
        brandId: number,
        splitTestId: number,
        from: string,
        to: string,
    ): Promise<SplitTestSignificance> {
        const res = await this.raw('GET', `/api/brands/${brandId}/split-tests/${splitTestId}/significance`, {
            params: { from, to },
        });
        if (res.status >= 400) throw httpError('Read split test significance', res);
        return (res.data ?? {}) as SplitTestSignificance;
    }

    /**
     * Per-variant metric values for one test.
     *
     * The dimension is `split-test:<id>` — the grouping field carries the test
     * id rather than it travelling as a filter, which is what lets the server
     * resolve variant keys (`v0`, `v1`) to the names configured on that test.
     */
    async getSplitTestMetrics(
        brandId: number,
        splitTestId: number,
        opts: AnalyticsQuery & { metrics: string[] },
    ): Promise<AnalyticsGroupRow[]> {
        return this.getAnalyticsGrouped(brandId, `split-test:${splitTestId}`, opts);
    }

    // ── Dashboards ───────────────────────────────────────────────────

    async listDashboards(brandId: number): Promise<DashboardConfig[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/dashboards`);
        if (res.status >= 400) throw httpError('List dashboards', res);
        const body = res.data as { data?: DashboardConfig[] } | DashboardConfig[];
        return Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data! : []);
    }

    async listDashboardPresets(brandId: number): Promise<DashboardPreset[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/dashboards/presets`);
        if (res.status >= 400) throw httpError('List dashboard presets', res);
        const body = res.data as { data?: DashboardPreset[] } | DashboardPreset[];
        return Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data! : []);
    }

    // ── Assets ───────────────────────────────────────────────────────

    async listAssets(brandId: number): Promise<Asset[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/file-manager/files`, {
            params: { per_page: 10000 },
        });
        if (res.status >= 400) throw httpError('List assets', res);
        const body = res.data as Asset[] | { data?: Asset[] };
        return Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data! : []);
    }

    async getAssetByPath(brandId: number, assetPath: string): Promise<{ id: number; file_name: string; file_path: string; html?: string } | null> {
        const normalized = normalizeAssetPath(assetPath);
        if (!normalized) return null;
        const res = await this.raw('GET', `/api/brands/${brandId}/file-manager/by-path`, {
            params: { path: normalized },
        });
        if (res.status === 404 || res.status === 422) return null;
        if (res.status >= 400) throw httpError('Get asset by path', res);
        return res.data as { id: number; file_name: string; file_path: string; html?: string };
    }

    async getAssetContent(brandId: number, fileId: number): Promise<AssetEditorPayload> {
        const res = await this.raw('GET', `/api/brands/${brandId}/file-manager/${fileId}/editor`, {
            params: { disk_sync: 1 },
        });
        if (res.status >= 400) throw httpError('Get asset content', res);
        return res.data as AssetEditorPayload;
    }

    async getAssetsSyncDelta(brandId: number, updatedAfter?: string | null): Promise<Array<{ id: number; file_path: string; updated_at?: string | null; size?: number | null }>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/file-manager/sync-delta`, {
            params: updatedAfter ? { updated_after: updatedAfter } : {},
        });
        if (res.status >= 400) throw httpError('Get assets sync-delta', res);
        return Array.isArray(res.data) ? res.data : [];
    }

    async uploadAssetByPath(brandId: number, assetPath: string, bytes: Uint8Array): Promise<{ id: number; file_name: string; file_path: string } | null> {
        const normalized = normalizeAssetPath(assetPath);
        if (!normalized) throw new CliError(ExitCode.Validation, 'Asset path is required');

        const parts = normalized.split('/').filter(Boolean);
        const fileName = parts[parts.length - 1];
        const folderPath = parts.slice(0, -1).join('/');
        if (!fileName) throw new CliError(ExitCode.Validation, `Invalid asset path: "${assetPath}"`);

        const boundary = `----ElasticFunnelsCli${Date.now().toString(16)}`;
        const mime = mimeFromAssetPath(fileName);
        const beforeFile = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
            `Content-Type: ${mime}\r\n\r\n`,
            'utf8',
        );
        const afterFile = Buffer.from(
            `\r\n--${boundary}\r\n` +
            `Content-Disposition: form-data; name="custom_filename"\r\n\r\n` +
            `${fileName}\r\n` +
            `--${boundary}--\r\n`,
            'utf8',
        );
        const payload = Buffer.concat([beforeFile, Buffer.from(bytes), afterFile]);

        const res = await this.raw('POST', `/api/brands/${brandId}/file-manager/upload-file`, {
            params: { path: folderPath || '/' },
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            data: payload,
        });
        if (res.status >= 400) throw httpError('Upload asset', res);

        return await this.getAssetByPath(brandId, normalized);
    }

    /**
     * Upload many files into a single folder in one request via the
     * file-manager bulk endpoint. The server caps this at 20 files and 10 MB
     * each — callers are responsible for chunking. All files land under
     * `folderPath` (relative to the brand's asset root); pass an empty string
     * for the root.
     */
    async bulkUploadAssets(
        brandId: number,
        folderPath: string,
        files: Array<{ name: string; bytes: Uint8Array }>,
    ): Promise<BulkUploadResult> {
        if (files.length === 0) return { summary: { total: 0, uploaded: 0, failed: 0 }, files: [] };
        if (files.length > BULK_UPLOAD_MAX) {
            throw new CliError(ExitCode.Validation, `bulkUploadAssets accepts at most ${BULK_UPLOAD_MAX} files per call.`);
        }
        const boundary = `----ElasticFunnelsCliBulk${Date.now().toString(16)}`;
        const multipart = buildBulkUploadBody(boundary, normalizeAssetPath(folderPath), files);
        const res = await this.raw('POST', `/api/brands/${brandId}/file-manager/bulk-upload-files`, {
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            data: multipart,
        });
        if (res.status >= 400) throw httpError('Bulk upload assets', res);
        const body = res.data as Partial<BulkUploadResult>;
        return {
            summary: body.summary ?? { total: files.length, uploaded: 0, failed: 0 },
            files: Array.isArray(body.files) ? body.files : [],
        };
    }

    async updateAssetContent(brandId: number, fileId: number, html: string): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/file-manager/${fileId}/update-content`, {
            data: { html },
        });
        if (res.status >= 400) throw httpError('Update asset content', res);
    }

    async deleteAssetByPath(brandId: number, assetPath: string): Promise<void> {
        const normalized = normalizeAssetPath(assetPath);
        if (!normalized) throw new CliError(ExitCode.Validation, 'Asset path is required');
        const res = await this.raw('POST', `/api/brands/${brandId}/file-manager/delete-file`, {
            data: { path: normalized },
        });
        if (res.status >= 400) throw httpError('Delete asset', res);
    }

    // ── Backend scripts ──────────────────────────────────────────────

    async listBackendScripts(brandId: number): Promise<BackendScript[]> {
        const all: BackendScript[] = [];
        let page = 1;
        for (;;) {
            const res = await this.raw('GET', `/api/brands/${brandId}/backend-scripts`, {
                params: { per_page: 100, page },
            });
            if (res.status === 403 || res.status === 404) return [];
            if (res.status >= 400) throw httpError('List backend scripts', res);
            const body = res.data as { data?: BackendScript[]; last_page?: number };
            const data = body.data ?? (Array.isArray(res.data) ? (res.data as BackendScript[]) : []);
            all.push(...data);
            const lastPage = body.last_page ?? 1;
            if (page >= lastPage) break;
            page++;
        }
        return all;
    }

    async getBackendScript(brandId: number, idOrCode: number | string): Promise<BackendScript> {
        const res = await this.raw('GET', `/api/brands/${brandId}/backend-scripts/${encodeURIComponent(String(idOrCode))}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Backend script "${idOrCode}" not found.`);
        if (res.status >= 400) throw httpError('Get backend script', res);
        return res.data as BackendScript;
    }

    async createBackendScript(brandId: number, name: string, code: string, content = '', description?: string): Promise<BackendScript> {
        const res = await this.raw('POST', `/api/brands/${brandId}/backend-scripts`, {
            data: {
                name, code, content, status: 'active',
                ...(description != null ? { description } : {}),
            },
        });
        if (res.status >= 400) throw httpError('Create backend script', res);
        return res.data as BackendScript;
    }

    async updateBackendScript(brandId: number, idOrCode: number | string, content: string, extras?: { name?: string; description?: string }): Promise<BackendScript> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/backend-scripts/${encodeURIComponent(String(idOrCode))}`, {
            data: { content, ...extras },
        });
        if (res.status >= 400) throw httpError('Update backend script', res);
        return res.data as BackendScript;
    }

    async deleteBackendScript(brandId: number, idOrCode: number | string): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/backend-scripts/${encodeURIComponent(String(idOrCode))}`);
        if (res.status >= 400) throw httpError('Delete backend script', res);
    }

    // ── Automations ──────────────────────────────────────────────────

    async listAutomations(brandId: number): Promise<Automation[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/automations/all`);
        if (res.status === 403 || res.status === 404) return [];
        if (res.status >= 400) throw httpError('List automations', res);
        const body = res.data;
        if (Array.isArray(body)) return body as Automation[];
        const data = (body as { data?: Automation[] }).data;
        return Array.isArray(data) ? data : [];
    }

    /** Create an empty automation shell (only `title` is required server-side).
     *  The trigger + node graph are authored later in the builder. */
    async createAutomation(brandId: number, title: string): Promise<Automation> {
        const res = await this.raw('POST', `/api/brands/${brandId}/automations`, { data: { title } });
        if (res.status >= 400) throw httpError('Create automation', res);
        const body = res.data as { automation?: Automation };
        return body.automation ?? (res.data as Automation);
    }

    /** Save the Vue Flow graph. `draft: true` writes to a revision (never deploys
     *  live); publishing (draft: false) compiles + deploys and is intentionally
     *  not exposed by the CLI. */
    async saveAutomationBuilder(brandId: number, id: number, builderConfig: unknown, draft = true): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/automations/${id}/builder`, {
            data: { builder_config: builderConfig, draft },
        });
        if (res.status >= 400) throw httpError('Save automation builder', res);
    }

    async deleteAutomation(brandId: number, id: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/automations/${id}`);
        if (res.status >= 400) throw httpError('Delete automation', res);
    }

    // ── Emails ───────────────────────────────────────────────────────

    async listEmails(brandId: number): Promise<BrandEmail[]> {
        const all: BrandEmail[] = [];
        let page = 1;
        for (;;) {
            const res = await this.raw('GET', `/api/brands/${brandId}/emails`, { params: { per_page: 100, page } });
            if (res.status === 403 || res.status === 404) return [];
            if (res.status >= 400) throw httpError('List emails', res);
            const body = res.data as { data?: BrandEmail[]; last_page?: number };
            const data = body.data ?? (Array.isArray(res.data) ? (res.data as BrandEmail[]) : []);
            all.push(...data);
            const lastPage = body.last_page ?? 1;
            if (page >= lastPage) break;
            page++;
        }
        return all;
    }

    /** Full email incl. raw html/css/config (the `show` endpoint, id-or-code). */
    async getEmail(brandId: number, idOrCode: number | string): Promise<BrandEmail> {
        const res = await this.raw('GET', `/api/brands/${brandId}/emails/${encodeURIComponent(String(idOrCode))}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Email "${idOrCode}" not found.`);
        if (res.status >= 400) throw httpError('Get email', res);
        const body = res.data as { email?: BrandEmail } & BrandEmail;
        return body.email ?? body;
    }

    /** Create the email row (metadata only — the body goes through saveEmailBody). */
    async createEmail(brandId: number, meta: Record<string, unknown>): Promise<BrandEmail> {
        const res = await this.raw('POST', `/api/brands/${brandId}/emails`, { data: meta });
        if (res.status >= 400) throw httpError('Create email', res);
        const body = res.data as { email?: BrandEmail };
        return body.email ?? (res.data as BrandEmail);
    }

    async updateEmail(brandId: number, idOrCode: number | string, meta: Record<string, unknown>): Promise<BrandEmail> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/emails/${encodeURIComponent(String(idOrCode))}`, { data: meta });
        if (res.status >= 400) throw httpError('Update email', res);
        const body = res.data as { email?: BrandEmail } & BrandEmail;
        return body.email ?? body;
    }

    /** Write the email body. `config`/`css` MUST be resent to avoid wiping the
     *  server's GrapesJS graph / stylesheet (a missing field is stored as null). */
    async saveEmailBody(brandId: number, idOrCode: number | string, payload: { html: string; css?: string; config?: unknown }): Promise<void> {
        const data: Record<string, unknown> = { html: payload.html, css: payload.css ?? '' };
        if (payload.config !== undefined) data.config = payload.config;
        const res = await this.raw('POST', `/api/brands/${brandId}/emails/${encodeURIComponent(String(idOrCode))}/builder`, { data });
        if (res.status >= 400) throw httpError('Save email body', res);
    }

    async deleteEmail(brandId: number, idOrCode: number | string): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/emails/${encodeURIComponent(String(idOrCode))}`);
        if (res.status >= 400) throw httpError('Delete email', res);
    }

    // ── CRM ──────────────────────────────────────────────────────────
    // Prefix: /api/brands/{brand}/crm. Definitions (entity/pipeline/stage/field)
    // are MySQL; entries are Elasticsearch docs (string ids).

    async listCrmEntities(brandId: number): Promise<CrmEntity[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/crm/entities`);
        if (res.status === 403 || res.status === 404) return [];
        if (res.status >= 400) throw httpError('List CRM entities', res);
        return crmList<CrmEntity>(res.data);
    }

    async getCrmEntity(brandId: number, entityId: number): Promise<CrmEntity> {
        const res = await this.raw('GET', `/api/brands/${brandId}/crm/entities/${entityId}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `CRM entity ${entityId} not found.`);
        if (res.status >= 400) throw httpError('Get CRM entity', res);
        return crmModel<CrmEntity>(res.data, 'entity', 'data');
    }

    async createCrmEntity(brandId: number, payload: Record<string, unknown>): Promise<CrmEntity> {
        const res = await this.raw('POST', `/api/brands/${brandId}/crm/entities`, { data: payload });
        if (res.status >= 400) throw httpError('Create CRM entity', res);
        return crmModel<CrmEntity>(res.data, 'entity', 'data');
    }

    async deleteCrmEntity(brandId: number, entityId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/crm/entities/${entityId}`);
        if (res.status >= 400) throw httpError('Delete CRM entity', res);
    }

    async listCrmPipelines(brandId: number, entityId: number): Promise<CrmPipeline[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/crm/entities/${entityId}/pipelines`);
        if (res.status === 403 || res.status === 404) return [];
        if (res.status >= 400) throw httpError('List CRM pipelines', res);
        return crmList<CrmPipeline>(res.data);
    }

    async createCrmPipeline(brandId: number, entityId: number, payload: Record<string, unknown>): Promise<CrmPipeline> {
        const res = await this.raw('POST', `/api/brands/${brandId}/crm/entities/${entityId}/pipelines`, { data: payload });
        if (res.status >= 400) throw httpError('Create CRM pipeline', res);
        return crmModel<CrmPipeline>(res.data, 'pipeline', 'data');
    }

    async deleteCrmPipeline(brandId: number, pipelineId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/crm/pipelines/${pipelineId}`);
        if (res.status >= 400) throw httpError('Delete CRM pipeline', res);
    }

    async listCrmStages(brandId: number, pipelineId: number): Promise<CrmStage[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/crm/pipelines/${pipelineId}/stages`);
        if (res.status === 403 || res.status === 404) return [];
        if (res.status >= 400) throw httpError('List CRM stages', res);
        return crmList<CrmStage>(res.data);
    }

    async createCrmStage(brandId: number, pipelineId: number, payload: Record<string, unknown>): Promise<CrmStage> {
        const res = await this.raw('POST', `/api/brands/${brandId}/crm/pipelines/${pipelineId}/stages`, { data: payload });
        if (res.status >= 400) throw httpError('Create CRM stage', res);
        return crmModel<CrmStage>(res.data, 'stage', 'data');
    }

    async deleteCrmStage(brandId: number, stageId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/crm/stages/${stageId}`);
        if (res.status >= 400) throw httpError('Delete CRM stage', res);
    }

    async listCrmFields(brandId: number, entityId: number): Promise<CrmField[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/crm/entities/${entityId}/fields`);
        if (res.status === 403 || res.status === 404) return [];
        if (res.status >= 400) throw httpError('List CRM fields', res);
        return crmList<CrmField>(res.data);
    }

    async createCrmField(brandId: number, entityId: number, payload: Record<string, unknown>): Promise<CrmField> {
        const res = await this.raw('POST', `/api/brands/${brandId}/crm/entities/${entityId}/fields`, { data: payload });
        if (res.status >= 400) throw httpError('Create CRM field', res);
        return crmModel<CrmField>(res.data, 'field', 'data');
    }

    async deleteCrmField(brandId: number, fieldId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/crm/fields/${fieldId}`);
        if (res.status >= 400) throw httpError('Delete CRM field', res);
    }

    async listCrmEntries(brandId: number, entityId: number, filters: Record<string, string | number> = {}): Promise<CrmEntry[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/crm/entities/${entityId}/entries`, { params: filters });
        if (res.status === 403 || res.status === 404) return [];
        if (res.status >= 400) throw httpError('List CRM entries', res);
        return crmList<CrmEntry>(res.data);
    }

    async getCrmEntry(brandId: number, entryId: string): Promise<CrmEntry> {
        const res = await this.raw('GET', `/api/brands/${brandId}/crm/entries/${encodeURIComponent(entryId)}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `CRM entry ${entryId} not found.`);
        if (res.status >= 400) throw httpError('Get CRM entry', res);
        return crmModel<CrmEntry>(res.data, 'entry', 'data');
    }

    async createCrmEntry(brandId: number, entityId: number, payload: Record<string, unknown>): Promise<CrmEntry> {
        const res = await this.raw('POST', `/api/brands/${brandId}/crm/entities/${entityId}/entries`, { data: payload });
        if (res.status >= 400) throw httpError('Create CRM entry', res);
        return crmModel<CrmEntry>(res.data, 'entry', 'data');
    }

    async updateCrmEntry(brandId: number, entryId: string, payload: Record<string, unknown>): Promise<CrmEntry> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/crm/entries/${encodeURIComponent(entryId)}`, { data: payload });
        if (res.status >= 400) throw httpError('Update CRM entry', res);
        return crmModel<CrmEntry>(res.data, 'entry', 'data');
    }

    async moveCrmEntry(brandId: number, entryId: string, stageId: number): Promise<CrmEntry> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/crm/entries/${encodeURIComponent(entryId)}/stage`, { data: { stage_id: stageId } });
        if (res.status >= 400) throw httpError('Move CRM entry', res);
        return crmModel<CrmEntry>(res.data, 'entry', 'data');
    }

    async deleteCrmEntry(brandId: number, entryId: string): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/crm/entries/${encodeURIComponent(entryId)}`);
        if (res.status >= 400) throw httpError('Delete CRM entry', res);
    }

    // ── Templates ────────────────────────────────────────────────────

    async listTemplates(brandId: number): Promise<BrandTemplate[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/templates`);
        if (res.status >= 400) throw httpError('List templates', res);
        return (Array.isArray(res.data) ? res.data : []) as BrandTemplate[];
    }

    async getTemplatePages(brandId: number, templateIdOrSlug: number | string): Promise<BrandTemplatePage[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/templates/${encodeURIComponent(String(templateIdOrSlug))}/pages`);
        if (res.status >= 400) throw httpError('List template pages', res);
        return (Array.isArray(res.data) ? res.data : []) as BrandTemplatePage[];
    }

    // ── Domains ──────────────────────────────────────────────────────

    async listDomains(brandId: number): Promise<BrandDomain[]> {
        const all: BrandDomain[] = [];
        let page = 1;
        for (;;) {
            const res = await this.raw('GET', `/api/brands/${brandId}/domains`, {
                params: { per_page: 100, page },
            });
            if (res.status === 403 || res.status === 404) return [];
            if (res.status >= 400) throw httpError('List domains', res);
            const body = res.data as { data?: BrandDomain[]; last_page?: number };
            const data = body.data ?? (Array.isArray(res.data) ? (res.data as BrandDomain[]) : []);
            all.push(...data);
            const lastPage = body.last_page ?? 1;
            if (page >= lastPage) break;
            page++;
        }
        return all;
    }

    async getDomain(brandId: number, domainId: number): Promise<BrandDomain> {
        const res = await this.raw('GET', `/api/brands/${brandId}/domains/${domainId}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Domain #${domainId} not found.`);
        if (res.status >= 400) throw httpError('Get domain', res);
        return res.data as BrandDomain;
    }

    /**
     * Add a domain to the brand. Defaults to a dedicated (customer-owned) domain;
     * pass a `subdomain` (+ optional `subdomain_root`) to create a platform
     * subdomain instead. A dedicated domain kicks off async Cloudflare custom
     * hostname creation — the TXT ownership record appears a few seconds later
     * (poll {@link getDomainValidationInstructions}).
     */
    async createDomain(
        brandId: number,
        payload: { domain?: string; dedicated_domain?: boolean; subdomain?: string; subdomain_root?: string; merchant_id?: number | null },
    ): Promise<BrandDomain> {
        const res = await this.raw('POST', `/api/brands/${brandId}/domains`, { data: payload });
        if (res.status >= 400) throw httpError('Add domain', res);
        const body = res.data as { domain?: BrandDomain } | BrandDomain;
        return ('domain' in body && body.domain ? body.domain : body) as BrandDomain;
    }

    /** Fetch the DNS records (TXT ownership + CNAME → platform) needed to validate a domain. */
    async getDomainValidationInstructions(brandId: number, domainId: number): Promise<DomainValidationInstructions> {
        const res = await this.raw('GET', `/api/brands/${brandId}/domains/${domainId}/validation-instructions`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Domain #${domainId} not found.`);
        if (res.status >= 400) throw httpError('Get domain validation instructions', res);
        return res.data as DomainValidationInstructions;
    }

    /** Queue (re)validation of a dedicated domain — checks DNS + issues SSL. */
    async validateDomain(brandId: number, domainId: number): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/domains/${domainId}/validate`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Domain #${domainId} not found.`);
        if (res.status >= 400) throw httpError('Validate domain', res);
    }

    async deleteDomain(brandId: number, domainId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/domains/${domainId}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Domain #${domainId} not found.`);
        if (res.status >= 400) throw httpError('Delete domain', res);
    }

    /** Dry run of moving a domain to another brand of the same organization. */
    async previewDomainMove(brandId: number, domainId: number, opts: DomainMoveOptions): Promise<DomainMovePreview> {
        const res = await this.raw('POST', `/api/brands/${brandId}/domains/${domainId}/move/preview`, { data: opts });
        if (res.status >= 400) throw domainMoveError('Preview domain move', res);
        return res.data as DomainMovePreview;
    }

    /** Move a domain to another brand. No DNS re-verification: the domain stays live. */
    async applyDomainMove(brandId: number, domainId: number, opts: DomainMoveOptions): Promise<DomainMoveResult> {
        const res = await this.raw('POST', `/api/brands/${brandId}/domains/${domainId}/move/apply`, { data: opts });
        if (res.status >= 400) throw domainMoveError('Move domain', res);
        return res.data as DomainMoveResult;
    }

    // ── Tags ─────────────────────────────────────────────────────────
    // The coloured labels the dashboard's Pages and Components lists show.
    // One flat table per brand plus a join row per tagged record, so the
    // endpoints are brand-scoped and the RECORD is named by the caller
    // (`module_key` + `item_id`) rather than by the URL. They live under the
    // Pages module's route group whatever kind of record they end up on.

    /**
     * Every tag in the brand. Pass `scope` to additionally learn which of them
     * are on ONE record: the server answers with an `assigned` flag per tag,
     * which is the only way to read a record's tags — there is no
     * "tags of item X" endpoint.
     */
    async listTags(brandId: number, scope?: { moduleKey: string; itemId: number }): Promise<BrandTag[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/tags`, {
            params: scope ? { module_key: scope.moduleKey, item_id: scope.itemId } : {},
        });
        if (res.status >= 400) throw httpError('List tags', res);
        return (Array.isArray(res.data) ? res.data : []) as BrandTag[];
    }

    /** `color` is required by the server; the command layer always resolves one. */
    async createTag(brandId: number, payload: { name: string; color: string }): Promise<BrandTag> {
        const res = await this.raw('POST', `/api/brands/${brandId}/tags`, { data: payload });
        if (res.status >= 400) throw httpError('Create tag', res);
        return unwrapTag(res.data);
    }

    async updateTag(brandId: number, tagId: number, payload: { name: string; color: string }): Promise<BrandTag> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/tags/${tagId}`, { data: payload });
        if (res.status >= 400) throw httpError('Update tag', res);
        return unwrapTag(res.data);
    }

    /** Deletes the tag brand-wide, and every record's assignment of it. */
    async deleteTag(brandId: number, tagId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/tags/${tagId}`);
        if (res.status >= 400) throw httpError('Delete tag', res);
    }

    /**
     * Put a tag on one record.
     *
     * NOT idempotent: the server inserts a join row without checking for an
     * existing one, and there is no unique index behind it, so calling this
     * twice leaves a duplicate that takes two deletes to undo. Callers must
     * check `assigned` first — see `attachTags` in commands/tags.ts.
     */
    async assignTag(brandId: number, tagId: number, target: { moduleKey: string; itemId: number }): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/tags/${tagId}/assign`, {
            data: { module_key: target.moduleKey, item_id: target.itemId },
        });
        if (res.status >= 400) throw httpError('Assign tag', res);
    }

    /**
     * Take a tag off one record. Deletes ONE join row (404 when there is none),
     * so a duplicated assignment needs a second call.
     *
     * `item_id` goes in the query string: this is a DELETE, and the server
     * reads it from the merged request input.
     */
    async unassignTag(brandId: number, tagId: number, itemId: number): Promise<void> {
        const res = await this.raw('DELETE', `/api/brands/${brandId}/tags/${tagId}/unassign`, {
            params: { item_id: itemId },
        });
        if (res.status >= 400) throw httpError('Unassign tag', res);
    }

    // ── Exit popups (Modules/Exitpopups, plan gate moduleAccess:exitpopups) ──

    /** `GET exit-popups/all`: id + name of every popup that has content (server caches it ~5 min, bumped on save). */
    async listPopups(brandId: number): Promise<Array<{ id: number; name: string }>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/exit-popups/all`);
        if (res.status === 403) throw planOrAuthError('List popups', res);
        if (res.status >= 400) throw httpError('List popups', res);
        return (Array.isArray(res.data) ? res.data : []) as Array<{ id: number; name: string }>;
    }

    /** `GET exit-popups/{id}` (id + name) and `GET exit-popups/{id}/builder` (the GrapesJS project). */
    async getPopup(brandId: number, id: number): Promise<{ id: number; name: string; config: Record<string, unknown> }> {
        const res = await this.raw('GET', `/api/brands/${brandId}/exit-popups/${id}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Popup #${id} not found in this brand.`);
        if (res.status >= 400) throw httpError('Get popup', res);
        const cfg = await this.raw('GET', `/api/brands/${brandId}/exit-popups/${id}/builder`);
        if (cfg.status >= 400) throw httpError('Get popup content', cfg);
        const head = res.data as { id: number; name: string };
        return { id: Number(head.id), name: head.name, config: (cfg.data ?? {}) as Record<string, unknown> };
    }

    /** `POST exit-popups` {name, template}: the server seeds the content from a built-in template. */
    async createPopup(brandId: number, name: string, template: string): Promise<{ id: number; name: string }> {
        const res = await this.raw('POST', `/api/brands/${brandId}/exit-popups`, { data: { name, template } });
        if (res.status === 403) throw planOrAuthError('Create popup', res);
        if (res.status === 422) throw validationError('Popup', res);
        if (res.status >= 400) throw httpError('Create popup', res);
        const body = res.data as { exitpopup?: { id: number; name: string } };
        if (!body.exitpopup?.id) throw new CliError(ExitCode.Server, 'Create popup: the server answered without a popup id.');
        return { id: Number(body.exitpopup.id), name: body.exitpopup.name };
    }

    /**
     * `POST exit-popups/{id}/builder`: replaces the content. The runtime renders
     * `html` + `css`; the editor loads `config`. The server derives neither from
     * the other, so callers send all three (see `popupBuilderPayload`).
     */
    async savePopupContent(brandId: number, id: number, payload: { config: string; html: string; css: string; interactions: unknown[] }): Promise<void> {
        const res = await this.raw('POST', `/api/brands/${brandId}/exit-popups/${id}/builder`, { data: payload });
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Popup #${id} not found in this brand.`);
        if (res.status >= 400) throw httpError('Save popup', res);
    }

    // ── Collections (form stores) ───────────────────────────────────

    async listCollections(brandId: number): Promise<BrandCollection[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/collections/all`);
        if (res.status === 403) {
            throw new CliError(ExitCode.Auth, 'The collections module is not enabled for this brand (or your credential lacks access).');
        }
        if (res.status >= 400) throw httpError('List collections', res);
        return (Array.isArray(res.data) ? res.data : []) as BrandCollection[];
    }

    /** `ref` may be a numeric id or the collection code — the server accepts both. */
    async getCollection(brandId: number, ref: string | number): Promise<BrandCollection> {
        const res = await this.raw('GET', `/api/brands/${brandId}/collections/${encodeURIComponent(String(ref))}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No collection "${ref}" in this brand. Run "ef collections list".`);
        if (res.status >= 400) throw httpError('Get collection', res);
        const body = res.data as { collection?: BrandCollection } | BrandCollection;
        return ('collection' in body && body.collection ? body.collection : body) as BrandCollection;
    }

    /**
     * The numeric id for a collection id or code. Only `GET collections/{x}`
     * accepts a code; `/entries` (route-model binding) and `/fields`
     * (findOrFail) look up by id alone, and MySQL casts a code such as
     * "3s9shy" to 3, so passing the code reads ANOTHER collection (0 rows)
     * or 404s. Every sub-resource call goes through this.
     */
    async resolveCollectionId(brandId: number, ref: string | number): Promise<number> {
        if (typeof ref === 'number' || /^\d+$/.test(ref)) return Number(ref);
        const col = await this.getCollection(brandId, ref);
        if (col.id == null) throw new CliError(ExitCode.NotFound, `No collection "${ref}" in this brand. Run "ef collections list".`);
        return Number(col.id);
    }

    async getCollectionFields(brandId: number, ref: string | number): Promise<BrandCollectionField[]> {
        const id = await this.resolveCollectionId(brandId, ref);
        const res = await this.raw('GET', `/api/brands/${brandId}/collections/${id}/fields`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No collection "${ref}" in this brand.`);
        if (res.status >= 400) throw httpError('Get collection fields', res);
        const body = res.data as { fields?: BrandCollectionField[] } | BrandCollectionField[];
        return (Array.isArray(body) ? body : body.fields ?? []) as BrandCollectionField[];
    }

    async listCollectionEntries(brandId: number, ref: string | number, params?: Record<string, unknown>): Promise<unknown[]> {
        const id = await this.resolveCollectionId(brandId, ref);
        const res = await this.raw('GET', `/api/brands/${brandId}/collections/${id}/entries`, { params });
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No collection "${ref}" in this brand.`);
        if (res.status >= 400) throw httpError('List collection entries', res);
        return crmList<unknown>(res.data);
    }

    /**
     * Create a collection. The server generates the `code` — that code is what
     * a form's `action`/`data-collection` must reference, so callers should read
     * it off the returned object rather than guessing.
     */
    /**
     * `DELETE collections/{id}`: soft-deletes the collection (brand-scoped, `collections.delete`).
     * Takes the code or the id; the route binds by id, so a code is resolved first.
     */
    async deleteCollection(brandId: number, ref: string | number): Promise<number> {
        const id = await this.resolveCollectionId(brandId, ref);
        const res = await this.raw('DELETE', `/api/brands/${brandId}/collections/${id}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No collection "${ref}" in this brand. Run "ef collections list".`);
        if (res.status === 403) throw planOrAuthError('Delete collection', res);
        if (res.status >= 400) throw httpError('Delete collection', res);
        return id;
    }

    // ── Shipping profiles (Products → Shipping Profiles) ─────────────

    /** Every profile with its product count (`GET shipping-profiles`, paginated, 100 a page). */
    async listShippingProfiles(brandId: number): Promise<ShippingProfile[]> {
        const out: ShippingProfile[] = [];
        for (let page = 1; page <= 50; page++) {
            const res = await this.raw('GET', `/api/brands/${brandId}/shipping-profiles`, { params: { per_page: 100, page } });
            if (res.status === 403) throw planOrAuthError('List shipping profiles', res);
            if (res.status >= 400) throw httpError('List shipping profiles', res);
            const body = (res.data ?? {}) as { data?: ShippingProfile[]; last_page?: number };
            out.push(...(Array.isArray(body.data) ? body.data : Array.isArray(res.data) ? res.data as ShippingProfile[] : []));
            if (!body.last_page || page >= body.last_page) break;
        }
        return out;
    }

    async getShippingProfile(brandId: number, id: number): Promise<ShippingProfile> {
        const res = await this.raw('GET', `/api/brands/${brandId}/shipping-profiles/${id}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No shipping profile #${id} in this brand. Run "ef shipping-profiles list".`);
        if (res.status >= 400) throw httpError('Get shipping profile', res);
        return res.data as ShippingProfile;
    }

    async createShippingProfile(brandId: number, payload: Record<string, unknown>): Promise<ShippingProfile> {
        const res = await this.raw('POST', `/api/brands/${brandId}/shipping-profiles`, { data: payload });
        if (res.status === 422) throw validationError('Shipping profile', res);
        if (res.status === 403) throw planOrAuthError('Create shipping profile', res);
        if (res.status >= 400) throw httpError('Create shipping profile', res);
        const body = res.data as { profile?: ShippingProfile };
        return (body.profile ?? res.data) as ShippingProfile;
    }

    async updateShippingProfile(brandId: number, id: number, payload: Record<string, unknown>): Promise<ShippingProfile> {
        const res = await this.raw('PUT', `/api/brands/${brandId}/shipping-profiles/${id}`, { data: payload });
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No shipping profile #${id} in this brand.`);
        if (res.status === 422) throw validationError('Shipping profile', res);
        if (res.status === 403) throw planOrAuthError('Update shipping profile', res);
        if (res.status >= 400) throw httpError('Update shipping profile', res);
        return res.data as ShippingProfile;
    }

    /** Put one profile on products, or take it off (`profileId` null) — `products/bulk-set-shipping-profile`. */
    async assignShippingProfile(brandId: number, productIds: number[], profileId: number | null): Promise<number> {
        const res = await this.raw('POST', `/api/brands/${brandId}/products/bulk-set-shipping-profile`, {
            data: { product_ids: productIds, shipping_profile_id: profileId },
        });
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Assign shipping profile: ${(res.data as { error?: string })?.error ?? 'profile or product not found in this brand'}.`);
        if (res.status === 422) throw validationError('Assign shipping profile', res);
        if (res.status === 403) throw planOrAuthError('Assign shipping profile', res);
        if (res.status >= 400) throw httpError('Assign shipping profile', res);
        return Number((res.data as { updated_count?: number })?.updated_count ?? productIds.length);
    }

    async createCollection(brandId: number, payload: { name: string; fields: BrandCollectionField[] } & Record<string, unknown>): Promise<BrandCollection> {
        const res = await this.raw('POST', `/api/brands/${brandId}/collections`, { data: payload });
        if (res.status === 403) throw planOrAuthError('Create collection', res);
        if (res.status >= 400) throw httpError('Create collection', res);
        const body = res.data as { collection?: BrandCollection } | BrandCollection;
        return ('collection' in body && body.collection ? body.collection : body) as BrandCollection;
    }

    // ── Orders (conversions) and tracked sessions — read-only ────────

    /**
     * One page of the orders list (`ConversionsController@index`, ES-backed).
     *
     * Filter names are the ones that controller actually honours, checked
     * against it rather than guessed: `filter[funnel_id]`, `filter[page_id]`
     * and `filter[aff_id]` go through the unified-filter mapping (aff_id →
     * `merchant_affiliate_id`, and only for callers with `affiliates.view`);
     * `type` is TOP-LEVEL — a `filter[type]` is ignored. With no `type` the
     * server returns purchase + refund + chargeback. `start`/`end`/`tz` window
     * `purchased_at`. `per_page` is capped at 100 server-side.
     */
    async listConversions(brandId: number, params: Record<string, unknown>): Promise<Paginated<ConversionRow>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/conversions`, { params });
        if (res.status === 403) throw new CliError(ExitCode.Auth, 'The conversions module is not enabled for this brand (or your credential cannot read orders).');
        if (res.status >= 400) throw httpError('List orders', res);
        return normalizePage<ConversionRow>(res.data, 'orders');
    }

    /**
     * One page of the clicks list (`ClicksController@index`). A click is one
     * page load. Filters: `filter[funnel_id]`, `filter[aff_id]`, and
     * `filter[pgid]` for the page — that controller does NOT read `page_id`.
     */
    async listClicks(brandId: number, params: Record<string, unknown>): Promise<Paginated<ClickRow>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/clicks`, { params });
        if (res.status === 403) throw new CliError(ExitCode.Auth, 'The tracking module is not enabled for this brand (or your credential cannot read sessions).');
        if (res.status >= 400) throw httpError('List sessions', res);
        return normalizePage<ClickRow>(res.data, 'sessions');
    }

    /** Every click + event of one session (`ClicksController@sessionDetails`). Accepts a session id or a click code. */
    /**
     * One page of contacts (`ContactsController@index`). Params: `q` (name, email
     * or phone), `lifecycle` (all | customer | lead), `tag`, `email_status`,
     * `sms_status`, `sort`, `page`, `per_page` (max 100). PII arrives masked
     * unless the user holds `contacts.view_pii`.
     */
    async listContacts(brandId: number, params: Record<string, unknown>): Promise<ContactListPage> {
        const res = await this.raw('GET', `/api/brands/${brandId}/contacts`, { params });
        contactsGuard(res);
        if (res.status === 403) throw new CliError(ExitCode.Auth, 'Your credential cannot read contacts (needs the customers.view permission).');
        if (res.status >= 400) throw httpError('List contacts', res);
        const page = normalizePage<ContactListPage['data'][number]>(res.data, 'contacts');
        return { ...page, can_view_pii: !!(res.data as { can_view_pii?: boolean })?.can_view_pii };
    }

    /** One contact by public id. A merged contact's id answers with the survivor (`redirect_public_id`). */
    async getContact(brandId: number, publicId: string): Promise<{ contact: ContactDetail; redirect_public_id?: string }> {
        const res = await this.raw('GET', `/api/brands/${brandId}/contacts/${encodeURIComponent(publicId)}`);
        contactsGuard(res);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No contact ${publicId} in this brand.`);
        if (res.status === 403) throw new CliError(ExitCode.Auth, 'Your credential cannot read contacts (needs the customers.view permission).');
        if (res.status >= 400) throw httpError('Get contact', res);
        const body = (res.data ?? {}) as { contact?: ContactDetail; redirect_public_id?: string };
        if (!body.contact) throw new CliError(ExitCode.Server, 'The server returned no contact.');
        return body.redirect_public_id ? { contact: body.contact, redirect_public_id: body.redirect_public_id } : { contact: body.contact };
    }

    async getSessionDetails(brandId: number, sessionId: string): Promise<SessionDetails> {
        const res = await this.raw('GET', `/api/brands/${brandId}/clicks/session/${encodeURIComponent(sessionId)}`);
        if (res.status === 403) throw new CliError(ExitCode.Auth, 'Your credential cannot read this session (tracking module or permission).');
        if (res.status >= 400) throw httpError('Get session', res);
        const body = (res.data ?? {}) as Partial<SessionDetails>;
        return {
            geoData: body.geoData ?? [],
            events: Array.isArray(body.events) ? body.events : [],
            domains: body.domains,
            visit: body.visit ?? null,
            traffic_source: body.traffic_source ?? null,
        };
    }

    /**
     * One page's settings (`PagesController@show`) — any page type, unlike
     * `listPages`, which the CLI scopes to editor pages. The GrapesJS `config`
     * is dropped server-side; the page password hash is NOT, so callers must
     * never print the raw payload.
     */
    async getPageDetails(brandId: number, pageId: number): Promise<Page & Record<string, unknown>> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/${pageId}`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `Page #${pageId} not found in this brand.`);
        if (res.status >= 400) throw httpError('Get page', res);
        return res.data as Page & Record<string, unknown>;
    }

    // ── Internal HTTP helper ────────────────────────────────────────

    /**
     * Untyped request with the client's auth, retries and exit-code mapping, for
     * feature modules that keep their endpoints in one file (src/api/kitContextApi.ts).
     */
    async request(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: string,
        opts?: { params?: Record<string, unknown>; data?: unknown; headers?: Record<string, string> },
    ): Promise<AxiosResponse> {
        return this.raw(method, url, opts);
    }

    private async raw(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: string,
        opts?: { params?: Record<string, unknown>; data?: unknown; headers?: Record<string, string> },
    ): Promise<AxiosResponse> {
        requestStart();
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    const res = await this.http.request({ method, url, ...opts });
                    // Transient server responses (5xx/429) are retried with backoff.
                    if (shouldRetry(method, res.status, true, attempt)) {
                        await sleepForRetry(attempt, res);
                        continue;
                    }
                    return res;
                } catch (err) {
                    // Network-level failure (no response). Retry idempotent methods,
                    // else map to a stable exit code.
                    if (axios.isAxiosError(err) && !err.response) {
                        if (shouldRetry(method, 0, false, attempt)) {
                            await sleepForRetry(attempt);
                            continue;
                        }
                        throw new CliError(
                            ExitCode.Network,
                            `Could not reach ${this.apiUrl} (${err.code ?? err.message}) after ${RETRY_MAX} retries.`,
                        );
                    }
                    throw err;
                }
            }
        } finally {
            requestEnd();
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * The shared shape of an analytics read: a day range, the zone those days are
 * interpreted in, and optional scope filters.
 */
export interface AnalyticsQuery {
    /** Inclusive first day, `YYYY-MM-DD`. */
    start: string;
    /** Inclusive last day, `YYYY-MM-DD`. */
    end: string;
    /**
     * IANA zone. Always sent by the CLI: when it is absent the server falls
     * back to `America/Los_Angeles` rather than to the brand's own zone, which
     * silently shifts every day boundary for a brand outside that offset.
     */
    tz: string;
    pageId?: number;
    funnelId?: number;
    splitTestId?: number;
    affiliateId?: number | string;
    /** Rows to return on a grouped read. */
    limit?: number;
}

/** Best available display label for a grouped row; never an empty string. */
function labelFor(rowLabel: unknown, key: string): string {
    if (rowLabel != null && rowLabel !== '' && rowLabel !== 0) return String(rowLabel);
    if (key.trim() !== '') return key;
    return '(unlabeled)';
}

/**
 * Escape a grouping field for the URL path.
 *
 * `encodeURIComponent` is right for the general case but wrong for the one
 * field that carries a payload: split-test dimensions are `split-test:<id>`,
 * and percent-encoding the colon to `%3A` is not what the app sends. A colon
 * is a legal path-segment character (RFC 3986 §3.3), so it is put back.
 */
function encodeGroupField(field: string): string {
    return encodeURIComponent(field).replace(/%3A/gi, ':');
}

/** Query params common to every analytics endpoint. Omits what was not set. */
function analyticsParams(q: AnalyticsQuery): Record<string, unknown> {
    const params: Record<string, unknown> = { start: q.start, end: q.end, tz: q.tz };
    if (q.pageId != null) params.page_id = q.pageId;
    if (q.funnelId != null) params.funnel_id = q.funnelId;
    if (q.splitTestId != null) params.split_test_id = q.splitTestId;
    if (q.affiliateId != null) params.aff_id = q.affiliateId;
    if (q.limit != null) params.limit = q.limit;
    return params;
}

/**
 * Flatten a grouped response into rows.
 *
 * The endpoint returns an object keyed by a display string ("Index (8879)"),
 * with the real id and label repeated inside each row. Two things get handled
 * here: keys beginning with `_` are envelope metadata (`_meta` and friends),
 * not data — mapping them produces a junk row — and each remaining value is a
 * bag of `{metric: {value, formatted}}` mixed with `row_key`/`row_label`, so
 * the metrics have to be separated from the row's own identity fields.
 */
function normalizeGroupRows(data: unknown): AnalyticsGroupRow[] {
    const body = (data as { data?: unknown })?.data ?? data;
    if (!body || typeof body !== 'object') return [];

    const rows: AnalyticsGroupRow[] = [];
    for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
        if (key.startsWith('_')) continue;
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;

        const metrics: AnalyticsGroupRow['metrics'] = {};
        for (const [name, cell] of Object.entries(row)) {
            if (name === 'row_key' || name === 'row_label') continue;
            if (cell && typeof cell === 'object' && 'value' in (cell as object)) {
                const c = cell as { value: unknown; formatted?: unknown };
                metrics[name] = {
                    value: typeof c.value === 'number' ? c.value : Number(c.value ?? 0),
                    formatted: (c.formatted ?? null) as string | number | null,
                };
            }
        }

        rows.push({
            key: (row.row_key as string | number) ?? key,
            // `row_label` is 0 rather than a string on the catch-all "no
            // attribution" bucket, so fall back to the object key — and when
            // that is empty too, to a visible placeholder. A row whose label is
            // "" prints as a blank line that reads as a rendering glitch; the
            // numbers next to it are real and someone has to be able to see
            // that the LABEL is what went missing.
            label: labelFor(row.row_label, key),
            metrics,
        });
    }
    return rows;
}


/** Tag store/update responses wrap the model under `tag`; be tolerant either way. */
function unwrapTag(data: unknown): BrandTag {
    const body = data as { tag?: BrandTag } | BrandTag | null;
    if (body && typeof body === 'object' && 'tag' in body && body.tag) return body.tag;
    return body as BrandTag;
}

/**
 * Coerce an ES list response into a {@link Paginated}. The conversions index
 * answers a failed query with HTTP 200, an empty page and an `error` string —
 * surfacing that as a server error keeps "the query broke" from reading as
 * "there were no orders".
 */
/** A brand still on the old Customers report answers every contacts route with 404 `contacts_not_enabled`. */
function contactsGuard(res: AxiosResponse): void {
    if (res.status === 404 && (res.data as { error?: string } | undefined)?.error === 'contacts_not_enabled') {
        throw new CliError(ExitCode.NotFound, 'Contacts are not enabled for this brand yet (it still uses the old Customers report).');
    }
}

function normalizePage<T>(data: unknown, what: string): Paginated<T> {
    const body = (data ?? {}) as Partial<Paginated<T>>;
    if (body.error && (!Array.isArray(body.data) || body.data.length === 0)) {
        throw new CliError(ExitCode.Server, `The server could not load ${what}: ${body.error}`);
    }
    const rows = Array.isArray(body.data) ? body.data : (Array.isArray(data) ? data as T[] : []);
    return {
        total: Number(body.total ?? rows.length),
        last_page: Number(body.last_page ?? 1),
        current_page: Number(body.current_page ?? 1),
        per_page: Number(body.per_page ?? rows.length),
        data: rows,
    };
}

export function httpError(label: string, res: AxiosResponse): CliError {
    const status = res.status;
    const data = res.data as { message?: string; error?: string; errors?: Record<string, string[]> } | undefined;
    let detail = '';
    if (data?.message) {
        detail = data.message;
    } else if (data?.error) {
        detail = data.error;
    } else if (typeof res.data === 'string') {
        detail = res.data.slice(0, 200);
    }
    if (data?.errors && typeof data.errors === 'object') {
        const fieldDetails = Object.entries(data.errors)
            .map(([field, msgs]) => `${field}: ${(Array.isArray(msgs) ? msgs : [msgs]).join('; ')}`)
            .join(' | ');
        if (fieldDetails) detail = detail ? `${detail} (${fieldDetails})` : fieldDetails;
    }
    const code: ExitCodeValue = status === 401 || status === 403 ? ExitCode.Auth
        : status === 404 ? ExitCode.NotFound
        : status >= 500 ? ExitCode.Server
        : ExitCode.Error;
    return new CliError(code, `${label} failed (HTTP ${status}): ${detail || res.statusText || 'unknown error'}`);
}

/**
 * A refused move is about the TARGET brand (not a member, missing
 * domains.update there, another organization), not about the stored
 * credential, so a 403 here must not read as "your key was rejected".
 */
function domainMoveError(label: string, res: AxiosResponse): CliError {
    const data = res.data as { error?: string; message?: string; missing_permissions?: string[]; errors?: unknown } | undefined;
    if ((res.status === 403 || res.status === 422) && !data?.errors && (data?.error || data?.message)) {
        const missing = data?.missing_permissions?.length ? ` Missing: ${data.missing_permissions.join(', ')}.` : '';
        return new CliError(ExitCode.Validation, `${label} refused: ${data.error ?? data.message}${missing}`);
    }
    return httpError(label, res);
}

/**
 * A Laravel 422, reported as the server's own field messages ("is_checkout_page:
 * Checkout pages are not allowed for this brand…") with exit code 2. The
 * top-level `message` only repeats the first field error ("… (and 1 more
 * error)"), so it is used only when there are no field errors.
 */
function validationError(label: string, res: AxiosResponse): CliError {
    const data = res.data as { message?: string; error?: string; errors?: Record<string, string[] | string> } | undefined;
    const fields = data?.errors && typeof data.errors === 'object'
        ? Object.entries(data.errors).map(([field, msgs]) => `${field}: ${(Array.isArray(msgs) ? msgs : [msgs]).join('; ')}`)
        : [];
    const detail = fields.length ? fields.join(' | ') : (data?.message ?? data?.error ?? 'validation failed');
    return new CliError(ExitCode.Validation, `${label} rejected by the server (HTTP 422): ${detail}`);
}

/**
 * A 403 on a create endpoint is a plan rejection (the brand's plan lacks the
 * feature or hit its cap) or a permission refusal from a policy. Neither means
 * the credential is bad: a bad credential is a 401 and never gets this far, so
 * this must not use ExitCode.Auth, which appends "run ef login" advice.
 */
export function planOrAuthError(label: string, res: AxiosResponse): CliError {
    const data = res.data as { error?: string; message?: string; plan_error?: { message?: string } } | undefined;
    const planMsg = data?.plan_error?.message;
    if (planMsg) {
        return new CliError(ExitCode.Error, `${data?.error ?? `${label} not allowed on this plan`}: ${planMsg}`);
    }
    const detail = data?.message ?? data?.error ?? 'forbidden';
    return new CliError(ExitCode.Error,
        `${label} refused (HTTP 403): ${detail}\n  Your credential is valid; this account lacks the permission for this brand, or the brand's plan does not include it.`);
}

function buildRevisionConflictMessage(body: PageUpdateResponse | undefined): string {
    const serverRev = body?.server_revision_id ?? body?.latest_revision_id;
    const hint = serverRev != null ? String(serverRev) : 'none (no draft revision on server — try `ef pull` to refresh efmeta, or pass --force)';
    return `Server rejected the revision guard (latest draft id: ${hint}). Pull the latest with "ef pull <path>", then push again. ` +
        `If you intend to overwrite the server, re-run with --force.`;
}

function packageVersion(): string {
    try {
        return require('../../package.json').version as string;
    } catch {
        return '0.0.0';
    }
}

const _err: typeof AxiosError | undefined = undefined; // kept to silence unused import warning if linter is strict
void _err;

function mimeFromAssetPath(assetPath: string): string {
    const ext = (assetPath.split('.').pop() || '').toLowerCase();
    const map: Record<string, string> = {
        css: 'text/css', js: 'application/javascript', json: 'application/json', xml: 'application/xml',
        svg: 'image/svg+xml', txt: 'text/plain', html: 'text/html', htm: 'text/html',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
        ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
        mp4: 'video/mp4', webm: 'video/webm',
    };
    return map[ext] ?? 'application/octet-stream';
}

export function normalizeAssetPath(p: string): string {
    if (!p) return '';
    return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

/**
 * Build the multipart/form-data body for the bulk-upload endpoint. Each file
 * is sent as `files[i]` with a matching `filenames[i]` text field, and the
 * shared destination `path` is appended last — mirroring what the server's
 * `bulkUploadFiles` validator expects. Pure (no I/O) so it can be unit-tested.
 */
/** A local image file to upload alongside a product create/update. */
export interface ProductImageUpload {
    /** File name including extension (used for the multipart filename + MIME). */
    name: string;
    bytes: Uint8Array;
}

/**
 * Build the multipart/form-data body for a product create/update that includes
 * an image. Scalar fields are sent as text parts (objects/arrays are
 * JSON-encoded — the controller `json_decode`s variants/product_fields/etc.),
 * and the image is sent under the `image` field, which is the only way the
 * server stores a product image. Pure (no I/O) so it can be unit-tested.
 */
export function buildProductMultipartBody(
    boundary: string,
    fields: Record<string, unknown>,
    image: { name: string; bytes: Uint8Array },
): Buffer {
    const parts: Buffer[] = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
            `${text}\r\n`,
            'utf8',
        ));
    }
    parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="${image.name}"\r\n` +
        `Content-Type: ${mimeFromAssetPath(image.name)}\r\n\r\n`,
        'utf8',
    ));
    parts.push(Buffer.from(image.bytes));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    return Buffer.concat(parts);
}

export function buildBulkUploadBody(
    boundary: string,
    folderPath: string,
    files: Array<{ name: string; bytes: Uint8Array }>,
): Buffer {
    const parts: Buffer[] = [];
    files.forEach((f, i) => {
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="files[${i}]"; filename="${f.name}"\r\n` +
            `Content-Type: ${mimeFromAssetPath(f.name)}\r\n\r\n`,
            'utf8',
        ));
        parts.push(Buffer.from(f.bytes));
        parts.push(Buffer.from(
            `\r\n--${boundary}\r\n` +
            `Content-Disposition: form-data; name="filenames[${i}]"\r\n\r\n` +
            `${f.name}\r\n`,
            'utf8',
        ));
    });
    parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="path"\r\n\r\n` +
        `${folderPath}\r\n` +
        `--${boundary}--\r\n`,
        'utf8',
    ));
    return Buffer.concat(parts);
}
