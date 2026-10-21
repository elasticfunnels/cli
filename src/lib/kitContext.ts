// `ef context pull`: the brand's kit AI context as files an agent can read.
//
// Writes <dir>/.ef/context/:
//   kit.json      kit key/name, apply run, pages (slug + role), product map (old code -> new code)
//   brief.md      the owner's brief, plus the converted text of each brief file
//   facts.json    the offer facts (offer.json shape). The only source of claims, prices, numbers.
//   assets.json   product images and reference assets ({ assets, files }), each with its local path
//   assets/       the asset and brief files themselves
//   slots.json    the kit's image slots (prompt, aspect, status, pages using it)
//   missing.json  what is still missing, with `blocking` per row
//
// Read-only on the server and idempotent on disk: a JSON file is rewritten only when its
// content changed, an asset is downloaded only when it is new or its sha256 (or URL) moved,
// and a file the server no longer lists is removed from assets/.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ApiClient } from '../api/client';
import { KitContextApi, type KitContextBundle, type MissingRow } from '../api/kitContextApi';
import { safeText } from '../utils/sanitize';

export const CONTEXT_DIR = path.join('.ef', 'context');
const MAX_DOWNLOAD = 50 * 1024 * 1024;

/** Fetch bytes from an asset URL. Never sends the brand credential: asset URLs are CDN URLs. */
export type FetchBytes = (url: string) => Promise<Uint8Array>;

export const defaultFetchBytes: FetchBytes = async (url) => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    const { readCapped } = await import('./driveFetch');
    return new Uint8Array(await readCapped(res, MAX_DOWNLOAD, url));
};

/**
 * `<root>/<rel>` as a real directory inside the real project root: each component is lstat'ed,
 * created when missing, and refused when it is a symlink or not a directory. A planted
 * `.ef/context/assets -> ~/Documents` would otherwise have `ef context pull` write into, and
 * clean up (delete from), a directory outside the project.
 */
export async function ensureContainedDir(rootDir: string, rel: string): Promise<string> {
    const realRoot = await fs.promises.realpath(rootDir);
    let cur = realRoot;
    for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
        cur = path.join(cur, part);
        let st: fs.Stats | null = null;
        try {
            st = await fs.promises.lstat(cur);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (!st) {
            await fs.promises.mkdir(cur);
            continue;
        }
        if (st.isSymbolicLink()) throw new Error(`${path.relative(realRoot, cur)} is a symlink; refusing to write the kit context through it. Remove it and re-run.`);
        if (!st.isDirectory()) throw new Error(`${path.relative(realRoot, cur)} is not a directory; remove it and re-run.`);
    }
    const real = await fs.promises.realpath(cur);
    if (real !== cur || !(real === realRoot || real.startsWith(realRoot + path.sep))) {
        throw new Error(`${rel} resolves outside the project (${real}); refusing.`);
    }
    return real;
}

/** Refuse a path that exists as anything but a regular file (a symlink above all). */
async function assertRegularOrAbsent(file: string): Promise<void> {
    try {
        const st = await fs.promises.lstat(file);
        if (!st.isFile()) throw new Error(`${path.basename(file)} is a symlink or not a regular file; refusing to write through it.`);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
}

/** Write through a fresh temp file (O_EXCL, so a planted temp symlink fails) and rename over the target. */
async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
    await assertRegularOrAbsent(file);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        await fs.promises.writeFile(tmp, content, { flag: 'wx' });
        await fs.promises.rename(tmp, file);
    } catch (e) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
    }
}

export interface PullContextResult {
    dir: string;
    hasContext: boolean;
    written: string[];
    unchanged: string[];
    downloaded: string[];
    kept: string[];
    removed: string[];
    failed: Array<{ name: string; error: string }>;
    missing: MissingRow[];
    blockers: MissingRow[];
}

export interface PullContextOptions {
    fetchBytes?: FetchBytes;
}

export const sha256Hex = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex');

function safeName(name: string): string {
    const s = name.replace(/[/\\\0]/g, '-').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
    return (s || 'unnamed').slice(0, 120);
}

function extFromUrl(url: string): string {
    try {
        const e = path.extname(new URL(url).pathname);
        return /^\.[a-z0-9]{1,5}$/i.test(e) ? e.toLowerCase() : '';
    } catch {
        return '';
    }
}

async function writeIfChanged(file: string, content: string, out: PullContextResult, rel: string): Promise<void> {
    await assertRegularOrAbsent(file);
    try {
        if ((await fs.promises.readFile(file, 'utf8')) === content) {
            out.unchanged.push(rel);
            return;
        }
    } catch { /* new file */ }
    await atomicWrite(file, content);
    out.written.push(rel);
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

async function fileSha(p: string): Promise<string | null> {
    try {
        if (!(await fs.promises.lstat(p)).isFile()) return null;
        return sha256Hex(await fs.promises.readFile(p));
    } catch {
        return null;
    }
}

/** Build brief.md: the typed brief, then each brief file's converted text. */
export function composeBrief(b: KitContextBundle): string {
    const parts: string[] = [];
    const typed = (b.context?.brief_md ?? '').trim();
    if (typed) parts.push(typed);
    for (const f of b.files) {
        const md = (f.converted_md ?? '').trim();
        if (md) parts.push(`## From ${f.name}\n\n${md}`);
    }
    return parts.length ? parts.join('\n\n') + '\n' : '';
}

/**
 * Pull the context into `<rootDir>/.ef/context`. `rootDir` is the project root for the CLI
 * and the job workspace for the runner.
 */
export async function pullKitContext(rootDir: string, api: ApiClient, brandId: number, opts: PullContextOptions = {}): Promise<PullContextResult> {
    const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
    const ctxApi = new KitContextApi(api, brandId);
    const dir = await ensureContainedDir(rootDir, CONTEXT_DIR);
    const assetsDir = await ensureContainedDir(rootDir, path.join(CONTEXT_DIR, 'assets'));

    const out: PullContextResult = { dir, hasContext: false, written: [], unchanged: [], downloaded: [], kept: [], removed: [], failed: [], missing: [], blockers: [] };
    const bundle = await ctxApi.get();
    const missing = await ctxApi.missing();
    out.hasContext = !!bundle.context;
    out.missing = missing;
    out.blockers = missing.filter((m) => m.blocking);

    const c = bundle.context;
    const kit = {
        context_id: c?.id ?? null,
        status: c?.status ?? null,
        run_id: c?.kit?.run_id ?? c?.template_apply_run_id ?? null,
        kit_id: c?.kit?.id ?? c?.builder_resource_id ?? null,
        key: c?.kit?.key ?? null,
        name: c?.kit?.name ?? null,
        pages: c?.kit?.pages ?? [],
        products: c?.kit?.products ?? [],
        drive_url: c?.drive_url ?? null,
        drive_synced_at: c?.drive_synced_at ?? null,
    };

    // Assets and brief files: download what is new or changed, keep the rest.
    const wanted = new Set<string>();
    const state = await readState(dir);
    const nextState: Record<string, { url: string; sha256: string }> = {};
    const fetchOne = async (key: string, name: string, url: string | null | undefined, sha: string | null | undefined): Promise<string | null> => {
        if (!url) return null;
        const ext = path.extname(name);
        const local = `${safeName(key)}-${safeName(name.replace(/\.[^.]+$/, ''))}${/^\.[a-z0-9]{1,8}$/i.test(ext) ? ext : extFromUrl(url)}`;
        const abs = path.join(assetsDir, local);
        wanted.add(local);
        const have = await fileSha(abs);
        const prev = state[local];
        const fresh = have !== null && (sha ? have === sha : prev?.url === url && prev.sha256 === have);
        if (fresh) {
            out.kept.push(local);
            nextState[local] = { url, sha256: have! };
            return `assets/${local}`;
        }
        try {
            const bytes = await fetchBytes(url);
            await atomicWrite(abs, bytes);
            out.downloaded.push(local);
            nextState[local] = { url, sha256: sha256Hex(bytes) };
            return `assets/${local}`;
        } catch (e) {
            out.failed.push({ name, error: (e as Error).message });
            return null;
        }
    };

    const assets = [];
    for (const a of bundle.assets) {
        assets.push({ ...a, local: await fetchOne(`a${a.id}`, a.name || `asset-${a.id}`, a.url, a.sha256) });
    }
    const files = [];
    for (const f of bundle.files) {
        files.push({ ...f, local: await fetchOne(`f${f.id}`, f.name || `file-${f.id}`, f.url, f.sha256) });
    }

    // Any regular file in assets/ the server no longer lists goes. Never recursive, never
    // through a symlink: a directory or link someone put there is left alone.
    for (const ent of await fs.promises.readdir(assetsDir, { withFileTypes: true })) {
        if (wanted.has(ent.name) || !ent.isFile()) continue;
        await fs.promises.unlink(path.join(assetsDir, ent.name));
        out.removed.push(ent.name);
    }

    await writeIfChanged(path.join(dir, 'kit.json'), json(kit), out, 'kit.json');
    await writeIfChanged(path.join(dir, 'brief.md'), composeBrief(bundle), out, 'brief.md');
    await writeIfChanged(path.join(dir, 'facts.json'), json(c?.facts ?? {}), out, 'facts.json');
    await writeIfChanged(path.join(dir, 'assets.json'), json({ assets, files }), out, 'assets.json');
    await writeIfChanged(path.join(dir, 'slots.json'), json(bundle.slots), out, 'slots.json');
    await writeIfChanged(path.join(dir, 'missing.json'), json(missing), out, 'missing.json');
    await writeIfChanged(path.join(dir, '.state.json'), json(nextState), { ...out, written: [], unchanged: [] }, '.state.json');
    return out;
}

async function readState(dir: string): Promise<Record<string, { url: string; sha256: string }>> {
    try {
        const j = JSON.parse(await fs.promises.readFile(path.join(dir, '.state.json'), 'utf8'));
        return j && typeof j === 'object' ? j : {};
    } catch {
        return {};
    }
}

/** missing.json as the agent reads it, or null when the context was never pulled. */
export async function readMissing(rootDir: string): Promise<MissingRow[] | null> {
    try {
        return JSON.parse(await fs.promises.readFile(path.join(rootDir, CONTEXT_DIR, 'missing.json'), 'utf8')) as MissingRow[];
    } catch {
        return null;
    }
}

/** One line per missing row, blockers first. */
export function formatMissing(rows: MissingRow[]): string[] {
    const sorted = [...rows].sort((a, b) => Number(b.blocking) - Number(a.blocking));
    return sorted.map((r) => {
        const pages = Array.isArray(r.pages) && r.pages.length ? ` (pages: ${r.pages.map(safeText).join(', ')})` : '';
        const fix = r.fix ? ` -> ${safeText(r.fix)}` : '';
        return `${r.blocking ? 'BLOCKER ' : ''}[${safeText(r.kind)}] ${safeText(r.label)}${pages}${fix}`;
    });
}

/**
 * Brief files stored as .docx with no `converted_md` yet: download, convert to Markdown and save
 * it back (PATCH ai-context/files/{id}). The app has no converter, so this runs on the CLI or the
 * runner, never in a web request. PDFs are left alone: the agent reads them natively.
 */
export async function convertPendingBriefs(api: ApiClient, brandId: number, opts: PullContextOptions = {}): Promise<{ converted: string[]; failed: Array<{ name: string; error: string }> }> {
    const { docxBytesToMarkdown } = await import('./docx2md');
    const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
    const ctxApi = new KitContextApi(api, brandId);
    const b = await ctxApi.get();
    const out = { converted: [] as string[], failed: [] as Array<{ name: string; error: string }> };
    for (const f of b.files) {
        const isDocx = /\.docx$/i.test(f.name) || f.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (!isDocx || (f.converted_md ?? '').trim() || !f.url) continue;
        try {
            const md = docxBytesToMarkdown(await fetchBytes(f.url));
            await ctxApi.setConvertedMd(f.id, md);
            out.converted.push(f.name);
        } catch (e) {
            out.failed.push({ name: f.name, error: (e as Error).message });
        }
    }
    return out;
}
