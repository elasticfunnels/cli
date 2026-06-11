import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import {
    Asset,
    AssetEditorPayload,
    BackendScript,
    Brand,
    BrandTemplate,
    BrandTemplatePage,
    Component,
    Page,
    PageFolder,
    PageUpdateResponse,
} from './types';
import { CliError, ExitCode, ExitCodeValue } from '../utils/exit';

/**
 * Distilled, VS-Code-free copy of the API surface the extension uses.
 * Same endpoints, same payloads — so a file produced by the CLI and a
 * file produced by the extension are byte-identical for the same content.
 */
export class ApiClient {
    private http: AxiosInstance;
    constructor(public readonly apiUrl: string, public readonly apiKey: string) {
        this.http = axios.create({
            baseURL: apiUrl,
            timeout: 60000,
            headers: {
                Accept: 'application/json',
                'EF-Access-Key': apiKey,
                'User-Agent': `ef-cli/${packageVersion()}`,
            },
            // Don't throw on >=400 inside the helper paths that want to inspect status; we
            // wrap normal calls in try/catch in callers.
            validateStatus: (s) => s >= 200 && s < 600,
        });
    }

    // ── Connection / brand discovery ─────────────────────────────────

    async ping(brandId: number): Promise<boolean> {
        const res = await this.raw('GET', `/api/brands/${brandId}/pages/all`, { params: { type: 'editor' } });
        return res.status === 200;
    }

    /**
     * List all brands the authenticated user has access to. Used during
     * `ef init` so the user can pick from a real list instead of typing
     * a brand id by hand.
     */
    async listBrands(): Promise<Brand[]> {
        const res = await this.raw('GET', '/api/brands/all');
        if (res.status === 401 || res.status === 403) {
            throw new CliError(ExitCode.Auth, 'API key was rejected. Make sure it\'s a valid ElasticFunnels brand API key.');
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

    // ── Internal HTTP helper ────────────────────────────────────────

    private async raw(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: string,
        opts?: { params?: Record<string, unknown>; data?: unknown; headers?: Record<string, string> },
    ): Promise<AxiosResponse> {
        try {
            return await this.http.request({ method, url, ...opts });
        } catch (err) {
            // Network-level failure (no response). Map to a stable exit code.
            if (axios.isAxiosError(err) && !err.response) {
                throw new CliError(
                    ExitCode.Network,
                    `Could not reach ${this.apiUrl} (${err.code ?? err.message}).`,
                );
            }
            throw err;
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
