// Download a link-shared Google Drive folder with no credentials and no dependencies.
//
// Port of ~/Work/elasticfunnels-launch-accelerator/lib/drive_fetch.py, same behaviour:
// a public folder page embeds its listing in `window['_DRIVE_ivd']`, which gives
// (id, name, mimeType) per entry and lets us recurse without the Drive API.
//
//   Google Docs   -> exported as Markdown        Google Sheets -> CSV (first tab only)
//   Google Slides -> PDF                         Google Drawing -> PNG
//   .docx         -> converted to .md, the .docx never kept
//   everything else allowed -> verbatim
//
// Kit customise adds an allow-list (PLAN.md section 3): images jpg/jpeg/png/webp/avif/gif,
// documents pdf/docx/md/txt, data csv/xlsx. Anything else is listed under `skipped` and
// not downloaded.
//
// Result code: 0 everything came down, 1 fatal (nothing usable), 2 completed but
// incomplete (per-file failures, a listing that may be truncated, or an empty folder).
// Treat 2 as "do not start the build yet".
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { convertDocx } from './docx2md';
import { safeText } from '../utils/sanitize';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const NATIVE_EXPORTS: Record<string, [string, string]> = {
    'application/vnd.google-apps.document': ['https://docs.google.com/document/d/{id}/export?format=markdown', '.md'],
    'application/vnd.google-apps.spreadsheet': ['https://docs.google.com/spreadsheets/d/{id}/export?format=csv', '.csv'],
    'application/vnd.google-apps.presentation': ['https://docs.google.com/presentation/d/{id}/export?format=pdf', '.pdf'],
    'application/vnd.google-apps.drawing': ['https://docs.google.com/drawings/d/{id}/export/png', '.png'],
};

export const UNFETCHABLE: Record<string, string> = {
    'application/vnd.google-apps.shortcut': "a shortcut, not a file. Ask the vendor to put the real file in the folder, or share the folder the shortcut points at.",
    'application/vnd.google-apps.form': 'a Google Form. There is no useful export; ask for the responses as a Sheet.',
    'application/vnd.google-apps.site': 'a Google Site. There is no export; ask for the content as a Doc.',
    'application/vnd.google-apps.map': 'a My Maps map. There is no export we can read.',
    'application/vnd.google-apps.script': 'an Apps Script project, not vendor material.',
    'application/vnd.google-apps.jam': 'a Jamboard. Ask for a PDF export instead.',
};

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'];
export const DOC_EXTS = ['.pdf', '.docx', '.md', '.txt'];
export const DATA_EXTS = ['.csv', '.xlsx'];
export const ALLOWED_EXTS = new Set([...IMAGE_EXTS, ...DOC_EXTS, ...DATA_EXTS]);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 100 * 1024 * 1024;

export class DriveError extends Error {
    constructor(message: string, public readonly code: number | null = null) {
        super(message);
        this.name = 'DriveError';
    }
}

export interface HttpResponse {
    status: number;
    headers: { get(name: string): string | null };
    body: Buffer;
}
/** One GET. Tests inject a fake; the default keeps cookies across calls (Drive's confirm flow needs them). */
export type HttpGet = (url: string) => Promise<HttpResponse>;

/** Hosts a Drive download, export or confirm form may point at. */
const DRIVE_HOSTS = new Set(['drive.usercontent.google.com', 'drive.google.com', 'docs.google.com']);
/**
 * Redirect hops only: exports and downloads land on Google's content CDN, and a folder that
 * is not link-shared bounces to the sign-in page (listFolder turns that into the sharing help).
 */
const REDIRECT_SUFFIX = '.googleusercontent.com';
const REDIRECT_HOSTS = new Set(['accounts.google.com']);

/**
 * Throws unless `raw` is an https URL on a Google Drive host on the default port, with no
 * userinfo. `redirect` also admits *.googleusercontent.com (where exports land). This is the
 * only thing standing between a planted HTML "confirm page" in a shared folder and a GET to
 * localhost or a metadata endpoint, so every URL the downloader fetches goes through it.
 */
export function assertDriveUrl(raw: string, opts: { redirect?: boolean } = {}): URL {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new DriveError(`refusing to fetch a malformed URL from Drive: ${JSON.stringify(raw.slice(0, 200))}`);
    }
    const host = u.hostname.toLowerCase();
    const hostOk = DRIVE_HOSTS.has(host) || (!!opts.redirect && (REDIRECT_HOSTS.has(host) || (host.endsWith(REDIRECT_SUFFIX) && /^[a-z0-9.-]+$/.test(host))));
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !hostOk) {
        throw new DriveError(`refusing to fetch ${u.protocol}//${host}${u.port ? `:${u.port}` : ''}: only https Google Drive hosts are allowed`);
    }
    return u;
}

/** Read a response body, aborting once it passes `max` bytes (Content-Length can be absent or wrong). */
export async function readCapped(res: Response, max: number, what = 'response'): Promise<Buffer> {
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) {
        await res.body?.cancel().catch(() => undefined);
        throw new DriveError(`${what} is ${len} bytes, over the ${max} byte limit`);
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => undefined);
            throw new DriveError(`${what} is over the ${max} byte limit`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The real GET: Drive hosts only (checked on the first URL and on every redirect hop, which
 * are followed by hand), cookies kept per host and sent only back to the host that set them,
 * and the body capped while it streams. `fetchImpl` is for tests.
 */
export function makeHttpGet(fetchImpl: FetchLike = fetch, maxBytes = MAX_BYTES): HttpGet {
    const jars = new Map<string, Map<string, string>>();
    return async (url) => {
        let u = assertDriveUrl(url, { redirect: true });
        for (let hop = 0; ; hop++) {
            const jar = jars.get(u.hostname) ?? new Map<string, string>();
            jars.set(u.hostname, jar);
            const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
            const res = await fetchImpl(u.toString(), { headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(180_000) });
            const h = res.headers as unknown as { getSetCookie?: () => string[] };
            const set = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
            for (const c of set) {
                const m = /^([^=;\s]+)=([^;]*)/.exec(c);
                if (m) jar.set(m[1], m[2]);
            }
            const loc = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && loc) {
                await res.body?.cancel().catch(() => undefined);
                if (hop >= 10) throw new DriveError('too many redirects');
                u = assertDriveUrl(new URL(loc, u).toString(), { redirect: true });
                continue;
            }
            const body = await readCapped(res, maxBytes, 'file');
            return { status: res.status, headers: res.headers, body };
        }
    };
}

/** Drive ids are [A-Za-z0-9_-]; anything else from a listing never goes into a URL. */
export function assertDriveId(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new DriveError(`not a Drive id: ${JSON.stringify(id.slice(0, 80))}`);
    return id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with retries; 401/403/404 are decisions, not blips, and are not retried. */
export async function fetchUrl(get: HttpGet, url: string, retries = 3, delayMs = 1500): Promise<Buffer> {
    let last = '';
    let status: number | null = null;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await get(url);
            if (res.status < 400) return res.body;
            last = `HTTP ${res.status}`;
            status = res.status;
            if ([401, 403, 404].includes(res.status)) break;
        } catch (e) {
            if (e instanceof DriveError) throw e;
            last = (e as Error).message;
        }
        if (attempt < retries - 1) await sleep(delayMs * (attempt + 1));
    }
    throw new DriveError(`GET ${url} failed: ${last}`, status);
}

export function folderId(ref: string): string {
    const r = ref.trim();
    for (const re of [/\/folders\/([A-Za-z0-9_-]{10,})/, /[?&]id=([A-Za-z0-9_-]{10,})/]) {
        const m = re.exec(r);
        if (m) return m[1];
    }
    if (/^[A-Za-z0-9_-]{10,}$/.test(r)) return r;
    throw new DriveError(`cannot extract a folder id from ${JSON.stringify(ref)}`);
}

const JS_SIMPLE: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

/** Decode a JavaScript string literal's escapes (UTF-16 surrogate pairs rejoin by themselves in JS). */
export function jsUnescape(text: string): string {
    return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, body: string) => {
        if (body[0] === 'u' || body[0] === 'x') {
            if (body.length > 1 && /^[ux][0-9a-fA-F]+$/.test(body)) return String.fromCharCode(parseInt(body.slice(1), 16));
        }
        return JS_SIMPLE[body] ?? body;
    });
}

export const NOT_SHARED = (fid: string, code: number) =>
    `Drive would not show folder ${fid} to an anonymous visitor (HTTP ${code}).\n` +
    `  This tool has NO Google credentials, by design, so it can only read folders\n` +
    `  shared as 'Anyone with the link'. Two causes, and they look identical here:\n` +
    `    1. the folder is shared to specific accounts (or not shared at all)\n` +
    `       -> ask the vendor for General access: Anyone with the link, Viewer\n` +
    `    2. the id is wrong or the folder was deleted or moved\n` +
    `       -> open https://drive.google.com/drive/folders/${fid} in a private window;\n` +
    `          if it 404s for you too while signed out, it is cause 1\n` +
    `  If the vendor cannot loosen sharing, download the files by hand and upload them\n` +
    `  with \`ef assets add\`.`;

export interface DriveEntry { id: string; name: string; mimeType: string }

export async function listFolder(get: HttpGet, fid: string): Promise<{ title: string; entries: DriveEntry[] }> {
    let html: string;
    try {
        html = (await fetchUrl(get, `https://drive.google.com/drive/folders/${assertDriveId(fid)}`)).toString('utf8');
    } catch (e) {
        if (e instanceof DriveError && e.code !== null && [401, 403, 404].includes(e.code)) throw new DriveError(NOT_SHARED(fid, e.code));
        throw e;
    }
    const t = /<title>([\s\S]*?)<\/title>/.exec(html);
    const title = t ? t[1].replace(' - Google Drive', '').trim() : fid;
    const blob = /window\['_DRIVE_ivd'\]\s*=\s*'([\s\S]*?)';/.exec(html);
    if (!blob) {
        if (html.includes('ServiceLogin') || html.includes('Sign in')) throw new DriveError(NOT_SHARED(fid, 200));
        throw new DriveError(
            `folder ${fid} loaded, but its file listing could not be parsed. This tool reads an undocumented blob ` +
            `(window['_DRIVE_ivd']) out of Drive's own HTML; Google changing that page breaks it. Download the files by ` +
            `hand and upload them with \`ef assets add\`, and treat this as a tool bug to fix.`);
    }
    let data: unknown;
    try {
        data = JSON.parse(jsUnescape(blob[1]));
    } catch (e) {
        throw new DriveError(`malformed listing for folder ${fid}: ${(e as Error).message}`);
    }
    const entries: DriveEntry[] = [];
    const rows = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
    for (const item of rows) {
        if (!Array.isArray(item)) continue;
        const [eid, , name, mime] = item as unknown[];
        if (typeof eid === 'string' && typeof name === 'string' && typeof mime === 'string') entries.push({ id: eid, name, mimeType: mime });
    }
    return { title, entries };
}

export function safeName(name: string): string {
    const n = name.replace(/\//g, '-').replace(/\\/g, '-').replace(/\0/g, '').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
    return n || 'unnamed';
}

export function uniquePath(dir: string, name: string): string {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = path.join(dir, name);
    for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
    return candidate;
}

/** A real file, through Drive's large-file confirmation page when it shows one. */
export async function downloadBinary(get: HttpGet, fid: string, dest: string): Promise<number> {
    const url = `https://drive.usercontent.google.com/download?id=${assertDriveId(fid)}&export=download&confirm=t`;
    let res = await get(url);
    if (res.status >= 400) throw new DriveError(`GET ${url} failed: HTTP ${res.status}`, res.status);
    if ((res.headers.get('content-type') || '').startsWith('text/html')) {
        const body = res.body.toString('utf8');
        const form = /<form[^>]+action="([^"]+)"([\s\S]*?)<\/form>/.exec(body);
        if (!form) {
            throw new DriveError(
                "Drive returned an HTML page instead of file bytes. Usually the per-file download quota ('too many people " +
                "have viewed or downloaded this file'), which clears on its own within a day; sometimes the file itself is " +
                'not link-shared even though its folder is. Open the file\'s own Drive link in a private window to tell them apart.');
        }
        const action = assertDriveUrl(form[1].replace(/&amp;/g, '&'));
        if (action.search || action.hash) throw new DriveError('Drive confirm form has an unexpected action URL; not following it.');
        const fields = new URLSearchParams();
        const re = /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(form[2]))) fields.set(m[1], m[2]);
        if (!fields.has('confirm')) fields.set('confirm', 't');
        res = await get(`${action.origin}${action.pathname}?${fields.toString()}`);
        if (res.status >= 400) throw new DriveError(`download confirm failed: HTTP ${res.status}`, res.status);
    }
    return writeChecked(res, dest);
}

/** Write via a .part file and check the declared length: a short file must never take the real name. */
function writeChecked(res: HttpResponse, dest: string): number {
    const declared = res.headers.get('content-length');
    const expected = declared && /^\d+$/.test(declared) ? parseInt(declared, 10) : null;
    const total = res.body.length;
    if (expected !== null && total !== expected) {
        throw new DriveError(`truncated download: got ${total} bytes of ${expected}. The connection dropped or timed out mid-file; re-run to retry.`);
    }
    const part = `${dest}.part`;
    try {
        fs.writeFileSync(part, res.body);
        fs.renameSync(part, dest);
    } catch (e) {
        fs.rmSync(part, { force: true });
        throw e;
    }
    return total;
}

export async function exportNative(get: HttpGet, fid: string, mime: string, dest: string): Promise<number> {
    const [url] = NATIVE_EXPORTS[mime];
    const data = await fetchUrl(get, url.replace('{id}', assertDriveId(fid)));
    const head = data.subarray(0, 15).toString('utf8').trimStart();
    if (head.startsWith('<!DOCTYPE html') || data.subarray(0, 6).toString('utf8') === '<html>') {
        throw new DriveError('export returned an HTML error page (not link-shared?)');
    }
    fs.writeFileSync(dest, data);
    return data.length;
}

export const fileSha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export interface ManifestFile {
    driveId: string;
    name: string;
    mimeType: string;
    path: string;
    kind: 'exported' | 'converted' | 'binary' | 'planned' | 'kept';
    bytes: number | null;
    sha256: string | null;
    exportedAs?: string;
    convertedFrom?: string;
    caveat?: string;
    media?: string[];
}

export interface DriveManifest {
    source: { folderId: string; url: string; title: string | null; fetchedAt: string };
    root: string;
    folders: Array<{ driveId: string; name: string; path: string }>;
    files: ManifestFile[];
    failures: Array<{ driveId: string; name: string; mimeType: string; error: string }>;
    skipped: Array<{ driveId: string; name: string; mimeType: string; reason: string }>;
    warnings: string[];
}

export interface DriveFetchOptions {
    out: string;
    dryRun?: boolean;
    log?: (line: string) => void;
    get?: HttpGet;
    /** Drive ids already stored elsewhere (the kit context): listed as `kept`, not downloaded again. */
    skipIds?: Set<string>;
}

/** The extension a Drive entry will have on disk, for the allow-list. */
export function landedExt(name: string, mime: string): string {
    if (NATIVE_EXPORTS[mime]) return NATIVE_EXPORTS[mime][1];
    if (mime === DOCX_MIME) return '.docx';
    return path.extname(name).toLowerCase();
}

async function handleFile(get: HttpGet, e: DriveEntry, name: string, outDir: string, rel: string, opts: DriveFetchOptions): Promise<ManifestFile> {
    const stem = name.slice(0, name.length - path.extname(name).length);
    const relOf = (p: string) => path.relative(opts.out, p).split(path.sep).join('/');
    if (UNFETCHABLE[e.mimeType]) throw new DriveError(`${name} is ${UNFETCHABLE[e.mimeType]}`);
    if (e.mimeType.startsWith('application/vnd.google-apps.') && !NATIVE_EXPORTS[e.mimeType]) {
        throw new DriveError(`${name} is a Google-native '${e.mimeType.split('.').pop()}', which this tool has no export for. Ask the vendor for it as a Doc, Sheet, Slides or a plain file.`);
    }
    if (opts.dryRun) {
        return { driveId: e.id, name, mimeType: e.mimeType, path: rel ? `${rel}/${name}` : name, kind: 'planned', bytes: null, sha256: null };
    }
    if (NATIVE_EXPORTS[e.mimeType]) {
        const ext = NATIVE_EXPORTS[e.mimeType][1];
        const dest = uniquePath(outDir, `${stem}${ext}`);
        const size = await exportNative(get, e.id, e.mimeType, dest);
        const rec: ManifestFile = { driveId: e.id, name, mimeType: e.mimeType, path: relOf(dest), kind: 'exported', exportedAs: ext.slice(1), bytes: size, sha256: fileSha256(dest) };
        if (e.mimeType === 'application/vnd.google-apps.spreadsheet') rec.caveat = 'CSV export covers the first sheet only; any further tabs in this workbook were not downloaded';
        return rec;
    }
    if (e.mimeType === DOCX_MIME || name.toLowerCase().endsWith('.docx')) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-docx-'));
        const tmp = path.join(tmpDir, 'in.docx');
        try {
            await downloadBinary(get, e.id, tmp);
            const dest = uniquePath(outDir, `${stem}.md`);
            const mediaDir = dest.slice(0, -3) + '.media';
            let result;
            try {
                result = convertDocx(tmp, dest, mediaDir);
            } catch (err) {
                throw new DriveError(`${name}: cannot convert the .docx: ${(err as Error).message}`);
            }
            const rec: ManifestFile = { driveId: e.id, name, mimeType: e.mimeType, path: relOf(dest), kind: 'converted', convertedFrom: 'docx', bytes: result.bytes, sha256: fileSha256(dest) };
            if (result.images.length) rec.media = result.images.map((i) => relOf(path.join(mediaDir, i)));
            return rec;
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
    const dest = uniquePath(outDir, name);
    const size = await downloadBinary(get, e.id, dest);
    return { driveId: e.id, name, mimeType: e.mimeType, path: relOf(dest), kind: 'binary', bytes: size, sha256: fileSha256(dest) };
}

async function walk(get: HttpGet, fid: string, outDir: string, rel: string, m: DriveManifest, opts: DriveFetchOptions, depth: number): Promise<void> {
    const log = opts.log ?? (() => {});
    const { title, entries } = await listFolder(get, fid);
    if (depth === 0) m.source.title = title;
    log(`${'  '.repeat(depth)}[dir] ${safeText(title)} (${entries.length} entries)`);
    if (entries.length >= 50) {
        m.warnings.push(`folder '${safeText(title)}' (${fid}) listed ${entries.length} entries; Drive pages its listing, so some files may be missing. Verify manually.`);
    }
    m.folders.push({ driveId: fid, name: title, path: rel || '.' });
    if (!opts.dryRun) fs.mkdirSync(outDir, { recursive: true });
    for (const e of entries) {
        const name = safeName(e.name);
        if (e.mimeType === FOLDER_MIME) {
            await walk(get, e.id, path.join(outDir, name), rel ? `${rel}/${name}` : name, m, opts, depth + 1);
            continue;
        }
        if (!UNFETCHABLE[e.mimeType]) {
            const ext = landedExt(name, e.mimeType);
            const nativeOk = !e.mimeType.startsWith('application/vnd.google-apps.') || !!NATIVE_EXPORTS[e.mimeType];
            if (nativeOk && !ALLOWED_EXTS.has(ext)) {
                m.skipped.push({ driveId: e.id, name: e.name, mimeType: e.mimeType, reason: `type ${ext || '(none)'} is not allowed` });
                log(`${'  '.repeat(depth)}  skip ${safeText(name)} (type ${safeText(ext) || 'none'} not allowed)`);
                continue;
            }
        }
        if (opts.skipIds?.has(e.id)) {
            m.files.push({ driveId: e.id, name, mimeType: e.mimeType, path: rel ? `${rel}/${name}` : name, kind: 'kept', bytes: null, sha256: null });
            log(`${'  '.repeat(depth)}  kept ${safeText(name)} (already in the context)`);
            continue;
        }
        try {
            const rec = await handleFile(get, e, name, outDir, rel, opts);
            m.files.push(rec);
            log(`${'  '.repeat(depth)}  ${rec.kind.slice(0, 4)} ${safeText(rec.path)} (${rec.bytes ?? 0}B)`);
        } catch (err) {
            log(`${'  '.repeat(depth)}  !! ${safeText(name)}: ${safeText((err as Error).message)}`);
            m.failures.push({ driveId: e.id, name: e.name, mimeType: e.mimeType, error: (err as Error).message });
        }
    }
}

export interface DriveFetchResult {
    code: 0 | 1 | 2;
    manifest: DriveManifest | null;
    error?: string;
    /** Lines for stderr: caveats, warnings, failures, empty folder. */
    notes: string[];
}

export async function driveFetch(ref: string, opts: DriveFetchOptions): Promise<DriveFetchResult> {
    const get = opts.get ?? makeHttpGet();
    let fid: string;
    try {
        fid = folderId(ref);
    } catch (e) {
        return { code: 1, manifest: null, error: (e as Error).message, notes: [] };
    }
    const out = path.resolve(opts.out);
    const m: DriveManifest = {
        source: { folderId: fid, url: `https://drive.google.com/drive/folders/${fid}`, title: null, fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00') },
        root: out,
        folders: [], files: [], failures: [], skipped: [], warnings: [],
    };
    try {
        await walk(get, fid, out, '', m, { ...opts, out }, 0);
    } catch (e) {
        return { code: 1, manifest: m, error: (e as Error).message, notes: [] };
    }
    if (!opts.dryRun) {
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    }
    const notes: string[] = [];
    for (const f of m.files) if (f.caveat) notes.push(`caveat: ${safeText(f.path)}: ${f.caveat}`);
    for (const w of m.warnings) notes.push(`WARNING: ${safeText(w)}`);
    if (m.failures.length) {
        notes.push(`${m.failures.length} file(s) did NOT come down:`);
        for (const f of m.failures) notes.push(`  - ${safeText(f.name)}: ${safeText(f.error)}`);
    }
    for (const s of m.skipped) notes.push(`skipped ${safeText(s.name)}: ${safeText(s.reason)}`);
    if (!m.files.length && !opts.dryRun && !m.skipped.length) {
        notes.push(`the folder listed no files at all. Check that the vendor put the material in ${fid} and not in a subfolder shared separately.`);
        return { code: 2, manifest: m, notes };
    }
    return { code: m.failures.length || m.warnings.length ? 2 : 0, manifest: m, notes };
}
