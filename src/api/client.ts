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
    BrandSeoConfig,
    BrandEmail,
    BrandTemplate,
    BrandTemplatePage,
    Component,
    CrmEntity,
    CrmEntry,
    CrmField,
    CrmPipeline,
    CrmStage,
    DomainValidationInstructions,
    Funnel,
    Page,
    PageFolder,
    PageUpdateResponse,
    PageVariant,
    Product,
    SeoPage,
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

    async listPages(brandId: number, limit = 10000): Promise<Page[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/all`, {
            params: { sort: 'title', type: 'editor' },
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
        if (res.status === 403) throw planOrAuthError(res);
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

    async getCollectionFields(brandId: number, ref: string | number): Promise<BrandCollectionField[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/collections/${encodeURIComponent(String(ref))}/fields`);
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No collection "${ref}" in this brand.`);
        if (res.status >= 400) throw httpError('Get collection fields', res);
        const body = res.data as { fields?: BrandCollectionField[] } | BrandCollectionField[];
        return (Array.isArray(body) ? body : body.fields ?? []) as BrandCollectionField[];
    }

    async listCollectionEntries(brandId: number, ref: string | number, params?: Record<string, unknown>): Promise<unknown[]> {
        const res = await this.raw('GET', `/api/brands/${brandId}/collections/${encodeURIComponent(String(ref))}/entries`, { params });
        if (res.status === 404) throw new CliError(ExitCode.NotFound, `No collection "${ref}" in this brand.`);
        if (res.status >= 400) throw httpError('List collection entries', res);
        return crmList<unknown>(res.data);
    }

    /**
     * Create a collection. The server generates the `code` — that code is what
     * a form's `action`/`data-collection` must reference, so callers should read
     * it off the returned object rather than guessing.
     */
    async createCollection(brandId: number, payload: { name: string; fields: BrandCollectionField[] } & Record<string, unknown>): Promise<BrandCollection> {
        const res = await this.raw('POST', `/api/brands/${brandId}/collections`, { data: payload });
        if (res.status === 403) throw planOrAuthError(res);
        if (res.status >= 400) throw httpError('Create collection', res);
        const body = res.data as { collection?: BrandCollection } | BrandCollection;
        return ('collection' in body && body.collection ? body.collection : body) as BrandCollection;
    }

    // ── Internal HTTP helper ────────────────────────────────────────

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

function httpError(label: string, res: AxiosResponse): CliError {
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
 * A 403 on product create can be either a plan-limit rejection (the brand has
 * hit its product cap / lacks the feature) or a genuine auth failure. Surface
 * the server's plan message when present so the user knows to upgrade rather
 * than re-check their key.
 */
function planOrAuthError(res: AxiosResponse): CliError {
    const data = res.data as { error?: string; plan_error?: { message?: string } } | undefined;
    const planMsg = data?.plan_error?.message;
    if (planMsg) {
        return new CliError(ExitCode.Error, `${data?.error ?? 'Cannot create product'}: ${planMsg}`);
    }
    return httpError('Create product', res);
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
