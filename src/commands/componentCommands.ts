import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { buildSyncContext, pullComponent } from '../sync/sync';
import { removeLocalEntity, resolveComponentByCodeOrName } from './shared';
import { relPathForComponent } from '../sync/paths';

export function registerComponentsCommand(program: Command): void {
    const cmd = program
        .command('components')
        .description('Component-specific actions: create, delete.');

    cmd.command('create <code>')
        .description('Create a new component on the server (and pull to disk).')
        .option('--name <name>', 'Display name (defaults to humanized code).')
        .option('--no-pull', 'Skip pulling the new component to disk after creating.')
        .option('--json', 'Print result as JSON.')
        .action(async (code: string, opts: { name?: string; pull?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const name = opts.name ?? code.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').replace(/(^|\s)\S/g, t => t.toUpperCase());
            // The Components API uses { name, code, html, type }. The "code" is the slug-like identifier.
            const created = await api.createComponent(rt.config.brandId, name, '', '');
            // The createComponent route doesn't accept a separate code field today; the
            // server derives the code from the name. We pull immediately so the user
            // sees the actual code allocated.
            void code;
            if (opts.pull !== false) {
                const ctx = await buildSyncContext(rt);
                await pullComponent(ctx, created.id);
                await ctx.state.save();
            }
            if (opts.json) { log.json({ ok: true, component: created }); return; }
            log.success(`Created component #${created.id} (${created.code ?? created.name}).`);
        });

    cmd.command('delete <codeOrName>')
        .description('Delete a component. Use --force to bypass usage check.')
        .option('--force', 'Delete even if pages reference this component.')
        .option('--json', 'Print result as JSON.')
        .action(async (codeOrName: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const comp = await resolveComponentByCodeOrName(api, rt.config.brandId, codeOrName);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete component #${comp.id} "${comp.code ?? comp.name}"?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deleteComponent(rt.config.brandId, comp.id, { force: opts.force });
            const rel = relPathForComponent(comp);
            const fileRemoved = await removeLocalEntity(rt, 'component', rel);
            if (opts.json) { log.json({ ok: true, deleted: { id: comp.id, code: comp.code }, localFileRemoved: fileRemoved }); return; }
            log.success(`Deleted component #${comp.id}.${fileRemoved ? ` Removed ${rel}.` : ''}`);
        });
}
