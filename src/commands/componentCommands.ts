import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { fileExists } from '../utils/fs';
import { buildSyncContext, pullComponent, pushComponentFile } from '../sync/sync';
import { removeLocalEntity, resolveComponentByCodeOrName } from './shared';
import { relPathForComponent } from '../sync/paths';

export function registerComponentsCommand(program: Command): void {
    const cmd = program
        .command('components')
        .description('Component-specific actions: create, push, delete.');

    cmd.command('create <code>')
        .description('Create a new component on the server (and pull to disk).')
        .option('--name <name>', 'Display name (defaults to humanized code).')
        .option('--no-pull', 'Skip pulling the new component to disk after creating.')
        .option('--json', 'Print result as JSON.')
        .action(async (code: string, opts: { name?: string; pull?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const name = opts.name ?? code.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').replace(/(^|\s)\S/g, t => t.toUpperCase());
            // Components API takes { name, code, html, type }; `code` is the
            // slug-like identifier. Sending '' is wrong: Laravel's
            // ConvertEmptyStringsToNull turns '' into null and the `string` rule
            // then rejects it ("The code must be a string"), so pass the real code.
            const created = await api.createComponent(rt.config.brandId, name, '', code);
            if (opts.pull !== false) {
                const ctx = await buildSyncContext(rt);
                await pullComponent(ctx, created.id);
                await ctx.state.save();
            }
            if (opts.json) { log.json({ ok: true, component: created }); return; }
            log.success(`Created component #${created.id} (${created.code ?? created.name}).`);
        });

    cmd.command('push <codeOrPath>')
        .description('Push a component. Pass a file path under components/ or a component code (uses components/<code>.ef).')
        .option('--draft', 'Save as a draft instead of publishing (overrides config saveMode).')
        .option('--direct', 'Publish directly (overrides config saveMode).')
        .option('--force', 'Skip optimistic concurrency (override a conflict).')
        .option('--json', 'Print result as JSON.')
        .action(async (codeOrPath: string, opts: { draft?: boolean; direct?: boolean; force?: boolean; json?: boolean }) => {
            if (opts.draft && opts.direct) {
                throw new CliError(ExitCode.Validation, '--draft and --direct are mutually exclusive.');
            }
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);
            // Accept a real file path, else treat the arg as a component code → components/<code>.ef.
            const asPath = path.isAbsolute(codeOrPath) ? codeOrPath : path.resolve(process.cwd(), codeOrPath);
            let abs: string;
            let rel: string;
            if (await fileExists(asPath)) {
                abs = asPath;
                rel = abs.startsWith(rt.brandRoot + path.sep)
                    ? abs.slice(rt.brandRoot.length + 1).split(path.sep).join('/')
                    : `components/${path.basename(abs, '.ef')}.ef`;
            } else {
                rel = `components/${codeOrPath.replace(/^components\//, '').replace(/\.ef$/, '')}.ef`;
                abs = path.join(rt.brandRoot, rel);
                if (!(await fileExists(abs))) {
                    throw new CliError(ExitCode.NotFound, `No component file at ${abs}. Create it with "ef components create ${codeOrPath}", or run "ef pull" first.`);
                }
            }
            const draft = opts.draft ? true : opts.direct ? false : (rt.config.saveMode === 'draft');
            const res = await pushComponentFile(ctx, abs, rel, { force: opts.force, draft });
            await ctx.state.save();
            if (opts.json) { log.json({ ok: true, draft, pushed: res }); return; }
            log.success(`${res.action} component ${res.rel}${res.revisionId ? ` (rev ${res.revisionId})` : ''}.`);
            if (draft && (res.action === 'created' || res.action === 'updated')) {
                log.warn('Saved as DRAFT — not live yet. Re-run with --direct to publish (or set "saveMode": "direct").');
            }
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
