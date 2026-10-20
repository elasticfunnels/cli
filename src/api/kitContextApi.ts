// Endpoints for the brand's kit AI context (P1 of _dev/kit-customize/PLAN.md in the app)
// and the kit image generator, kept together so the contract lives in one file.
//
// All under /api/brands/{brand}/, with the caller's ApiClient auth: the human CLI's
// EF-Access-Key, or a runner's Bearer agent token + x-runner-id ('ai-context' is in
// BrandAgentToken::ALLOWED_RESOURCES).
import { ApiClient, httpError } from './client';
import { CliError, ExitCode } from '../utils/exit';

export interface KitContextPage { id: number; slug: string; role?: string | null }
export interface KitContextProduct { id?: number | null; old_code?: string | null; code: string; name?: string | null }
export interface KitContextKit {
    id?: number | null;
    key?: string | null;
    name?: string | null;
    run_id?: number | null;
    pages?: KitContextPage[];
    products?: KitContextProduct[];
}

export interface KitContext {
    id: number;
    template_apply_run_id?: number | null;
    builder_resource_id?: number | null;
    brief_md?: string | null;
    facts?: Record<string, unknown> | null;
    drive_url?: string | null;
    drive_synced_at?: string | null;
    drive_manifest?: unknown;
    status?: string | null;
    kit?: KitContextKit | null;
}

export interface KitAsset {
    id: number;
    url: string;
    name?: string | null;
    mime_type?: string | null;
    kind?: string | null;
    source?: string | null;
    product_code?: string | null;
    role?: string | null;
    drive_file_id?: string | null;
    sha256?: string | null;
}

export interface KitContextFile {
    id: number;
    name: string;
    mime?: string | null;
    url?: string | null;
    sha256?: string | null;
    converted_md?: string | null;
    drive_file_id?: string | null;
}

export interface KitSlot {
    id?: number | null;
    slot: string;
    prompt?: string | null;
    aspect?: string | null;
    status?: string | null;
    url?: string | null;
    kit_image?: string | null;
    needs?: unknown;
    applied?: Array<{ slug?: string; id?: number; selector?: string }>;
}

export interface MissingRow {
    kind: string;
    key?: string | null;
    label: string;
    pages?: string[];
    fix?: string | null;
    blocking: boolean;
}

export interface KitContextBundle {
    context: KitContext | null;
    assets: KitAsset[];
    files: KitContextFile[];
    slots: KitSlot[];
}

export interface ImageEstimate {
    credits_per_image: number;
    count: number;
    total_credits: number;
    balance: number;
    balance_after: number;
    can_afford: boolean;
}

export interface KitImage {
    id: number;
    slot: string;
    status: string;
    credits?: number;
    url?: string | null;
    error?: string | null;
    refunded?: boolean;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** One multipart/form-data body: text fields plus at most one file. */
export function multipart(fields: Record<string, string | number | undefined | null>, file?: { field: string; name: string; mime: string; bytes: Uint8Array }): { body: Buffer; contentType: string } {
    const boundary = `----EfKitContext${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null || v === '') continue;
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`, 'utf8'));
    }
    if (file) {
        const safe = file.name.replace(/["\r\n]/g, '_');
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safe}"\r\nContent-Type: ${file.mime}\r\n\r\n`, 'utf8'));
        parts.push(Buffer.from(file.bytes));
        parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export class KitContextApi {
    constructor(private readonly api: ApiClient, private readonly brandId: number) {}

    private base(): string {
        return `/api/brands/${this.brandId}/ai-context`;
    }

    async get(): Promise<KitContextBundle> {
        const res = await this.api.request('GET', this.base());
        if (res.status === 404) return { context: null, assets: [], files: [], slots: [] };
        if (res.status >= 400) throw httpError('Read AI context', res);
        return this.bundle(res.data);
    }

    async put(patch: { brief_md?: string; facts?: Record<string, unknown>; drive_url?: string | null; drive_synced_at?: string; drive_manifest?: unknown }): Promise<KitContextBundle> {
        const res = await this.api.request('PUT', this.base(), { data: patch });
        if (res.status >= 400) throw httpError('Save AI context', res);
        return this.bundle(res.data);
    }

    async missing(): Promise<MissingRow[]> {
        const res = await this.api.request('GET', `${this.base()}/missing`);
        if (res.status === 404) return [];
        if (res.status >= 400) throw httpError('Read missing items', res);
        const d = res.data as { data?: unknown } | unknown[];
        return arr<MissingRow>(Array.isArray(d) ? d : (d as { data?: unknown }).data).map((r) => ({ ...r, blocking: r.blocking === true }));
    }

    async addAsset(input: { name: string; mime: string; bytes: Uint8Array; productCode?: string; role?: string; source: 'upload' | 'drive' | 'generated'; driveFileId?: string; sha256?: string }): Promise<KitAsset> {
        const mp = multipart(
            { product_code: input.productCode, role: input.role, source: input.source, drive_file_id: input.driveFileId, sha256: input.sha256 },
            { field: 'file', name: input.name, mime: input.mime, bytes: input.bytes },
        );
        const res = await this.api.request('POST', `${this.base()}/assets`, { data: mp.body, headers: { 'Content-Type': mp.contentType } });
        if (res.status >= 400) throw httpError(`Upload asset ${input.name}`, res);
        const d = res.data as { asset?: KitAsset } & KitAsset;
        return d.asset ?? d;
    }

    async addFile(input: { name: string; mime: string; bytes: Uint8Array; source?: string; driveFileId?: string; sha256?: string; convertedMd?: string }): Promise<KitContextFile> {
        const mp = multipart(
            { source: input.source, drive_file_id: input.driveFileId, sha256: input.sha256, converted_md: input.convertedMd },
            { field: 'file', name: input.name, mime: input.mime, bytes: input.bytes },
        );
        const res = await this.api.request('POST', `${this.base()}/files`, { data: mp.body, headers: { 'Content-Type': mp.contentType } });
        if (res.status >= 400) throw httpError(`Upload file ${input.name}`, res);
        const d = res.data as { file?: KitContextFile } & KitContextFile;
        return d.file ?? d;
    }

    async setConvertedMd(fileId: number, md: string): Promise<KitContextFile> {
        const res = await this.api.request('PATCH', `${this.base()}/files/${fileId}`, { data: { converted_md: md } });
        if (res.status >= 400) throw httpError('Save converted brief', res);
        const d = res.data as { file?: KitContextFile } & KitContextFile;
        return d.file ?? d;
    }

    // ── Kit images (KitImagesController) ──────────────────────────────

    async imageEstimate(count = 1): Promise<ImageEstimate> {
        const res = await this.api.request('GET', `/api/brands/${this.brandId}/ai-images/estimate`, { params: { count } });
        if (res.status >= 400) throw httpError('Image price', res);
        return res.data as ImageEstimate;
    }

    async generateImage(input: { kitId: number; slot: string; prompt: string; aspect?: string; referenceIds?: number[]; idempotencyKey: string }): Promise<KitImage> {
        const res = await this.api.request('POST', `/api/brands/${this.brandId}/ai-images`, {
            data: {
                kit_id: input.kitId,
                slot: input.slot,
                prompt: input.prompt,
                ...(input.aspect ? { aspect: input.aspect } : {}),
                ...(input.referenceIds?.length ? { reference_ids: input.referenceIds } : {}),
                idempotency_key: input.idempotencyKey,
            },
        });
        if (res.status === 402) {
            const d = res.data as { total_credits?: number; balance?: number };
            throw new CliError(ExitCode.Validation, `Not enough AI credits: this image costs ${d.total_credits ?? '?'} and the balance is ${d.balance ?? '?'}.`);
        }
        if (res.status >= 400) throw httpError('Generate image', res);
        return (res.data as { image: KitImage }).image;
    }

    async getImage(id: number): Promise<KitImage> {
        const res = await this.api.request('GET', `/api/brands/${this.brandId}/ai-images/${id}`);
        if (res.status >= 400) throw httpError('Read image', res);
        return (res.data as { image: KitImage }).image;
    }

    private bundle(data: unknown): KitContextBundle {
        const d = (data ?? {}) as Record<string, unknown>;
        const ctx = (d.context ?? null) as KitContext | null;
        return { context: ctx, assets: arr<KitAsset>(d.assets), files: arr<KitContextFile>(d.files), slots: arr<KitSlot>(d.slots) };
    }
}
