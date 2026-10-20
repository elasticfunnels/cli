import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient, BULK_UPLOAD_MAX, normalizeAssetPath } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { mapWithConcurrency } from '../utils/concurrency';
import { buildSyncContext, pullAsset } from '../sync/sync';
import { relPathForAsset } from '../sync/paths';
import { removeLocalEntity } from './shared';
import { sha256 } from '../utils/fs';
import { KitContextApi } from '../api/kitContextApi';
import { IMAGE_EXTS, ALLOWED_EXTS } from '../lib/driveFetch';
import { syncDrive, mimeFor } from '../lib/driveSync';

export const ASSET_ROLES = ['packshot', 'label', 'logo', 'lifestyle', 'reference', 'testimonial', 'certificate'];

const TEN_MB = 10 * 1024 * 1024;

export function registerAssetsCommand(program: Command): void {
    const cmd = program
        .command('assets')
        .description('Asset (file-manager) actions: upload, delete, pull.');

    cmd.command('upload <localPath>')
        .description('Upload a local file to the brand\'s asset store. By default the remote path mirrors the local filename.')
        .option('--as <remotePath>', 'Remote path (e.g. "images/logo.png"). Required when uploading from outside the brand root.')
        .option('--json', 'Print result as JSON.')
        .action(async (localPath: string, opts: { as?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const abs = path.isAbsolute(localPath) ? localPath : path.resolve(process.cwd(), localPath);
            let stat: fs.Stats;
            try { stat = await fs.promises.stat(abs); } catch {
                throw new CliError(ExitCode.NotFound, `File not found: ${localPath}`);
            }
            if (!stat.isFile()) throw new CliError(ExitCode.Validation, `Not a file: ${localPath}`);

            let remote = opts.as ? normalizeAssetPath(opts.as) : undefined;
            if (!remote) {
                // Auto-derive: if the file is inside <brandRoot>/assets/, mirror that
                // sub-path on the server. Otherwise use just the filename at the root.
                const assetsRoot = path.join(rt.brandRoot, 'assets');
                if (abs.startsWith(assetsRoot + path.sep)) {
                    remote = abs.slice(assetsRoot.length + 1).split(path.sep).join('/');
                } else {
                    remote = path.basename(abs);
                }
            }

            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const bytes = await fs.promises.readFile(abs);
            const uploaded = await api.uploadAssetByPath(rt.config.brandId, remote, bytes);
            if (!uploaded) {
                throw new CliError(ExitCode.Server, `Server accepted the upload but did not return a file id.`);
            }
            const ctx = await buildSyncContext(rt);
            ctx.state.setEntry('asset', {
                path: `assets/${remote}`,
                id: uploaded.id,
                type: 'asset',
                updatedAt: new Date().toISOString(),
                serverUpdatedAt: new Date().toISOString(),
                contentHash: sha256(bytes),
            });
            await ctx.state.save();
            if (opts.json) { log.json({ ok: true, asset: uploaded }); return; }
            log.success(`Uploaded ${remote} (#${uploaded.id}).`);
        });

    cmd.command('add <file>')
        .description('Add a product image or brief file to the kit AI context (images: jpg/png/webp/avif/gif; files: pdf/docx/md/txt/csv/xlsx).')
        .option('--product <code>', 'Product code the image shows.')
        .option('--role <role>', `What it is: ${ASSET_ROLES.join(', ')}.`)
        .option('--json', 'Print the result as JSON.')
        .action(async (file: string, opts: { product?: string; role?: string; json?: boolean }) => {
            if (opts.role && !ASSET_ROLES.includes(opts.role)) {
                throw new CliError(ExitCode.Validation, `Unknown role "${opts.role}". Roles: ${ASSET_ROLES.join(', ')}.`);
            }
            const abs = path.resolve(process.cwd(), file);
            let bytes: Buffer;
            try { bytes = await fs.promises.readFile(abs); } catch {
                throw new CliError(ExitCode.NotFound, `File not found: ${file}`);
            }
            const name = path.basename(abs);
            const ext = path.extname(name).toLowerCase();
            if (!ALLOWED_EXTS.has(ext)) throw new CliError(ExitCode.Validation, `${name}: type ${ext || '(none)'} is not allowed. Images: jpg, jpeg, png, webp, avif, gif; files: pdf, docx, md, txt, csv, xlsx.`);
            const rt = await loadRuntime();
            const ctxApi = new KitContextApi(new ApiClient(rt.config.apiUrl, rt.apiKey, rt.auth), rt.config.brandId);
            if (IMAGE_EXTS.includes(ext)) {
                const a = await ctxApi.addAsset({ name, mime: mimeFor(name), bytes, productCode: opts.product, role: opts.role, source: 'upload', sha256: sha256(bytes) });
                if (opts.json) { log.json({ ok: true, asset: a }); return; }
                log.success(`Added ${name} as asset #${a.id}${opts.product ? ` for ${opts.product}` : ''}${opts.role ? ` (${opts.role})` : ''}.`);
                return;
            }
            if (opts.product || opts.role) log.warn('--product/--role apply to images only; saving this as a brief file.');
            const f = await ctxApi.addFile({ name, mime: mimeFor(name), bytes, source: 'upload', sha256: sha256(bytes), ...(ext === '.md' || ext === '.txt' ? { convertedMd: bytes.toString('utf8') } : {}) });
            if (opts.json) { log.json({ ok: true, file: f }); return; }
            log.success(`Added ${name} as file #${f.id}.`);
        });

    cmd.command('sync-drive [url]')
        .description('Download the kit\'s link-shared Google Drive folder (no Google login) and add it to the kit AI context. Docs -> md, Sheets -> csv, Slides -> pdf, docx -> md; other types are skipped. Exit 2 = incomplete.')
        .option('--json', 'Print the result as JSON.')
        .action(async (url: string | undefined, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey, rt.auth);
            const r = await syncDrive(api, rt.config.brandId, { url, log: opts.json ? undefined : (l) => log.detail(l) });
            if (opts.json) {
                log.json({ ok: r.code === 0, code: r.code, url: r.url, error: r.error ?? null, uploaded: r.uploaded, alreadyThere: r.alreadyThere, uploadFailed: r.uploadFailed, skipped: r.manifest?.skipped ?? [], failures: r.manifest?.failures ?? [], warnings: r.manifest?.warnings ?? [] });
            } else {
                if (r.error) log.error(r.error);
                for (const n of r.notes) process.stderr.write(`sync-drive: ${n}\n`);
                for (const f of r.uploadFailed) log.warn(`upload ${f.name}: ${f.error}`);
                if (r.code !== 1) log.success(`Drive sync: ${r.uploaded.length} added, ${r.alreadyThere.length} already there${r.code === 2 ? ' (INCOMPLETE: see above)' : ''}.`);
            }
            if (r.code !== 0) process.exitCode = r.code === 1 ? ExitCode.Error : ExitCode.Validation;
        });

    cmd.command('bulk-upload <paths...>')
        .description('Upload many files at once (file-manager bulk endpoint). Pass files and/or directories (walked recursively).')
        .option('--to <remoteDir>', 'Remote base folder to upload into. Defaults to mirroring local paths.')
        .option('--flat', 'Ignore local subfolders — drop every file directly under --to (or the root).')
        .option('--concurrency <n>', 'Parallel batch requests (default 4).', (v) => parseInt(v, 10))
        .option('--json', 'Print result as JSON.')
        .action(async (paths: string[], opts: { to?: string; flat?: boolean; concurrency?: number; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const assetsRoot = path.join(rt.brandRoot, 'assets');

            // Resolve every input into {abs, remoteFolder, name}. Files over the
            // server's 10 MB limit are skipped up front so we don't waste a round-trip.
            const collected: Array<{ abs: string; folder: string; name: string }> = [];
            const skipped: Array<{ path: string; reason: string }> = [];
            for (const input of paths) {
                const abs = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
                let stat: fs.Stats;
                try { stat = await fs.promises.stat(abs); } catch {
                    throw new CliError(ExitCode.NotFound, `Path not found: ${input}`);
                }
                if (stat.isDirectory()) {
                    for (const file of await walkFiles(abs)) {
                        const relDir = opts.flat ? '' : path.relative(abs, path.dirname(file)).split(path.sep).join('/');
                        collected.push({ abs: file, folder: joinRemote(opts.to, relDir), name: path.basename(file) });
                    }
                } else if (stat.isFile()) {
                    let relDir = '';
                    if (!opts.flat && !opts.to && abs.startsWith(assetsRoot + path.sep)) {
                        relDir = path.relative(assetsRoot, path.dirname(abs)).split(path.sep).join('/');
                    }
                    collected.push({ abs, folder: joinRemote(opts.to, relDir), name: path.basename(abs) });
                } else {
                    skipped.push({ path: input, reason: 'not a regular file' });
                }
            }

            // Drop oversized files (server would reject them anyway).
            const uploadable: typeof collected = [];
            for (const f of collected) {
                const { size } = await fs.promises.stat(f.abs);
                if (size > TEN_MB) {
                    skipped.push({ path: f.abs, reason: `${(size / TEN_MB * 10).toFixed(1)} MB exceeds 10 MB limit` });
                } else {
                    uploadable.push(f);
                }
            }
            if (uploadable.length === 0) {
                if (opts.json) { log.json({ ok: true, summary: { total: 0, uploaded: 0, failed: 0 }, files: [], skipped }); return; }
                log.info('Nothing to upload.');
                for (const s of skipped) log.detail(`skipped ${s.path}: ${s.reason}`);
                return;
            }

            // Group by remote folder, then chunk each group to the per-request cap.
            const byFolder = new Map<string, typeof uploadable>();
            for (const f of uploadable) {
                const list = byFolder.get(f.folder) ?? [];
                list.push(f);
                byFolder.set(f.folder, list);
            }
            const batches: Array<{ folder: string; files: typeof uploadable }> = [];
            for (const [folder, list] of byFolder) {
                for (let i = 0; i < list.length; i += BULK_UPLOAD_MAX) {
                    batches.push({ folder, files: list.slice(i, i + BULK_UPLOAD_MAX) });
                }
            }

            const results = await mapWithConcurrency(batches, opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 4, async (batch) => {
                const payload = await Promise.all(batch.files.map(async (f) => ({ name: f.name, bytes: await fs.promises.readFile(f.abs) })));
                const res = await api.bulkUploadAssets(rt.config.brandId, batch.folder, payload);
                return { folder: batch.folder, ...res };
            });

            const allFiles = results.flatMap(r => r.files.map(f => ({ ...f, folder: r.folder })));
            const uploaded = allFiles.filter(f => f.status === 'uploaded').length;
            const failed = allFiles.filter(f => f.status !== 'uploaded');

            if (opts.json) {
                log.json({ ok: failed.length === 0, summary: { total: allFiles.length, uploaded, failed: failed.length }, files: allFiles, skipped });
                return;
            }
            log.success(`Uploaded ${uploaded}/${allFiles.length} file(s) across ${byFolder.size} folder(s).`);
            for (const f of failed) log.warn(`${c.bold(f.folder || '/')}/${f.filename}: ${f.error ?? 'failed'}`);
            for (const s of skipped) log.detail(`skipped ${s.path}: ${s.reason}`);
            log.detail('Server-side asset list updated. Run `ef pull` to sync the new files to disk and .ef-state.');
        });

    cmd.command('delete <remotePath>')
        .description('Delete an asset by its server-side path.')
        .option('--force', 'Do not require confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (remotePath: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete asset "${remotePath}"?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deleteAssetByPath(rt.config.brandId, remotePath);
            const rel = relPathForAsset({ file_path: remotePath, file_name: remotePath, id: 0 });
            const fileRemoved = await removeLocalEntity(rt, 'asset', rel);
            if (opts.json) { log.json({ ok: true, deleted: remotePath, localFileRemoved: fileRemoved }); return; }
            log.success(`Deleted asset "${remotePath}".${fileRemoved ? ` Removed ${rel}.` : ''}`);
        });

    cmd.command('pull <remotePath>')
        .description('Pull a single asset to disk.')
        .option('--json', 'Print result as JSON.')
        .action(async (remotePath: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);
            const ref = await ctx.api.getAssetByPath(ctx.rt.config.brandId, remotePath);
            if (!ref) throw new CliError(ExitCode.NotFound, `Asset "${remotePath}" not found.`);
            const out = await pullAsset(ctx, ref.id);
            await ctx.state.save();
            if (opts.json) { log.json({ ok: true, pulled: out?.rel }); return; }
            log.success(`Pulled ${out?.rel}.`);
        });
}

/** Recursively collect every regular file under `dir` (absolute paths). */
async function walkFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walkFiles(abs));
        else if (entry.isFile()) out.push(abs);
    }
    return out;
}

/** Join an optional remote base folder with a relative sub-dir into one clean path. */
function joinRemote(base: string | undefined, relDir: string): string {
    return normalizeAssetPath([base ?? '', relDir].filter(Boolean).join('/'));
}
