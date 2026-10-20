// `ef assets sync-drive`: fetch the brand's Drive folder (driveFetch.ts) and upload what came
// down to the kit AI context. Images go to the assets endpoint, documents and data to the
// files endpoint, both with source=drive + drive_file_id. A file already in the context with
// the same drive_file_id is not uploaded again (the server re-encodes images, so sha256 of
// the original never matches the stored file). The manifest is saved on the context.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiClient } from '../api/client';
import { KitContextApi } from '../api/kitContextApi';
import { driveFetch, IMAGE_EXTS, type DriveManifest, type HttpGet } from './driveFetch';

const MIME: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const mimeFor = (p: string) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

export interface SyncDriveResult {
    code: 0 | 1 | 2;
    url: string;
    uploaded: Array<{ name: string; as: 'asset' | 'file'; id: number }>;
    alreadyThere: string[];
    uploadFailed: Array<{ name: string; error: string }>;
    manifest: DriveManifest | null;
    notes: string[];
    error?: string;
}

export interface SyncDriveOptions {
    url?: string;
    /** Staging dir for the download; a temp dir (removed after) when omitted. */
    stagingDir?: string;
    log?: (line: string) => void;
    get?: HttpGet;
}

export async function syncDrive(api: ApiClient, brandId: number, opts: SyncDriveOptions = {}): Promise<SyncDriveResult> {
    const ctxApi = new KitContextApi(api, brandId);
    const before = await ctxApi.get();
    const url = (opts.url ?? before.context?.drive_url ?? '').trim();
    const empty = { uploaded: [], alreadyThere: [], uploadFailed: [], manifest: null, notes: [] };
    if (!url) return { code: 1, url, ...empty, error: 'No Drive link: pass one (ef assets sync-drive <url>) or save it on the kit context first.' };

    const staging = opts.stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ef-drive-'));
    try {
        const have = new Set<string>();
        for (const a of before.assets) if (a.drive_file_id) have.add(a.drive_file_id);
        for (const f of before.files) if (f.drive_file_id) have.add(f.drive_file_id);
        const fetched = await driveFetch(url, { out: staging, log: opts.log, get: opts.get, skipIds: have });
        if (fetched.code === 1 || !fetched.manifest) {
            return { code: 1, url, ...empty, manifest: fetched.manifest, notes: fetched.notes, error: fetched.error };
        }
        const m = fetched.manifest;

        const res: SyncDriveResult = { code: fetched.code, url, uploaded: [], alreadyThere: [], uploadFailed: [], manifest: m, notes: fetched.notes };
        for (const f of m.files) {
            if (f.kind === 'kept' || have.has(f.driveId)) {
                res.alreadyThere.push(f.path);
                continue;
            }
            const abs = path.join(staging, f.path);
            try {
                const bytes = fs.readFileSync(abs);
                const name = path.basename(f.path);
                if (IMAGE_EXTS.includes(path.extname(name).toLowerCase())) {
                    const a = await ctxApi.addAsset({ name, mime: mimeFor(name), bytes, source: 'drive', driveFileId: f.driveId, sha256: f.sha256 ?? undefined });
                    res.uploaded.push({ name: f.path, as: 'asset', id: a.id });
                } else {
                    const isMd = path.extname(name).toLowerCase() === '.md';
                    const file = await ctxApi.addFile({
                        name, mime: mimeFor(name), bytes, source: 'drive', driveFileId: f.driveId, sha256: f.sha256 ?? undefined,
                        // Docs exported as Markdown and converted .docx are already the text the agent reads.
                        ...(isMd ? { convertedMd: bytes.toString('utf8') } : {}),
                    });
                    res.uploaded.push({ name: f.path, as: 'file', id: file.id });
                }
                have.add(f.driveId);
            } catch (e) {
                res.uploadFailed.push({ name: f.path, error: (e as Error).message });
            }
        }
        if (res.uploadFailed.length) res.code = 2;

        // Paths in the saved manifest are relative to the staging dir, which is gone after this.
        const saved = { ...m, root: null, uploadFailed: res.uploadFailed, exitCode: res.code };
        await ctxApi.put({ drive_url: url, drive_synced_at: new Date().toISOString(), drive_manifest: saved });
        return res;
    } finally {
        if (!opts.stagingDir) fs.rmSync(staging, { recursive: true, force: true });
    }
}
