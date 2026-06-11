import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { buildSyncContext, pullScript, pushScriptFile } from '../sync/sync';
import { relPathForScript } from '../sync/paths';
import { removeLocalEntity } from './shared';
import { fileExists } from '../utils/fs';

export function registerScriptsCommand(program: Command): void {
    const cmd = program
        .command('scripts')
        .description('Backend script actions: create, get, push, pull, delete.');

    cmd.command('create <code>')
        .description('Create a new backend script (empty body) and pull to disk.')
        .option('--name <name>', 'Display name (defaults to the code).')
        .option('--description <desc>', 'Description.')
        .option('--no-pull', 'Skip pulling to disk after creating.')
        .option('--json', 'Print result as JSON.')
        .action(async (code: string, opts: { name?: string; description?: string; pull?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const name = opts.name ?? code;
            const created = await api.createBackendScript(rt.config.brandId, name, code, '', opts.description);
            if (opts.pull !== false) {
                const ctx = await buildSyncContext(rt);
                await pullScript(ctx, created.id);
                await ctx.state.save();
            }
            if (opts.json) { log.json({ ok: true, script: created }); return; }
            log.success(`Created backend script #${created.id} (${created.code}).`);
        });

    cmd.command('pull <codeOrId>')
        .description('Pull one backend script to disk.')
        .option('--json', 'Print result as JSON.')
        .action(async (codeOrId: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);
            const out = await pullScript(ctx, codeOrId);
            await ctx.state.save();
            if (opts.json) { log.json({ ok: true, pulled: out.rel }); return; }
            log.success(`Pulled ${out.rel}.`);
        });

    cmd.command('push <pathOrCode>')
        .description('Push a backend script. Pass a file path under scripts/ or a script code (uses the local file at scripts/<code>.js).')
        .option('--force', 'Skip optimistic concurrency.')
        .option('--json', 'Print result as JSON.')
        .action(async (pathOrCode: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);
            let abs: string;
            let rel: string;
            const direct = path.isAbsolute(pathOrCode) ? pathOrCode : path.resolve(process.cwd(), pathOrCode);
            if (await fileExists(direct)) {
                abs = direct;
                rel = abs.startsWith(rt.brandRoot + path.sep)
                    ? abs.slice(rt.brandRoot.length + 1).split(path.sep).join('/')
                    : `scripts/${path.basename(abs, '.js')}.js`;
            } else {
                rel = `scripts/${pathOrCode.replace(/^scripts\//, '').replace(/\.js$/, '')}.js`;
                abs = path.join(rt.brandRoot, rel);
                if (!(await fileExists(abs))) {
                    throw new CliError(ExitCode.NotFound, `No script file at ${abs}. Pull it first or pass a real file path.`);
                }
            }
            const res = await pushScriptFile(ctx, abs, rel, { force: opts.force });
            await ctx.state.save();
            if (opts.json) { log.json({ ok: true, pushed: res }); return; }
            log.success(`${res.action === 'created' ? 'Created' : 'Updated'} script ${res.rel} (id ${res.serverId}).`);
        });

    cmd.command('get <codeOrId>')
        .description('Print one backend script (full payload as JSON, or just content).')
        .option('--json', 'Print full payload as JSON.')
        .action(async (codeOrId: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const s = await api.getBackendScript(rt.config.brandId, codeOrId);
            if (opts.json) { log.json(s); return; }
            process.stdout.write((s.content ?? '') + '\n');
        });

    cmd.command('delete <codeOrId>')
        .description('Delete a backend script.')
        .option('--force', 'Do not require confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (codeOrId: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const s = await api.getBackendScript(rt.config.brandId, codeOrId);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete backend script "${s.code}" (#${s.id})?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deleteBackendScript(rt.config.brandId, s.id);
            const rel = relPathForScript(s);
            const fileRemoved = await removeLocalEntity(rt, 'script', rel);
            if (opts.json) { log.json({ ok: true, deleted: { id: s.id, code: s.code }, localFileRemoved: fileRemoved }); return; }
            log.success(`Deleted backend script #${s.id}.${fileRemoved ? ` Removed ${rel}.` : ''}`);
        });
}
