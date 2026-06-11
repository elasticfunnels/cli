import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient, normalizeAssetPath } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { buildSyncContext, pullAsset } from '../sync/sync';
import { sha256 } from '../utils/fs';

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
            if (opts.json) { log.json({ ok: true, deleted: remotePath }); return; }
            log.success(`Deleted asset "${remotePath}".`);
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
