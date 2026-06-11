import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import {
    buildSyncContext,
    classifyAbsPath,
    pushAssetFile,
    pushComponentFile,
    pushPageFile,
    pushScriptFile,
    PushResult,
} from '../sync/sync';
import { resolveSyncPathInput } from '../utils/syncPathResolve';

interface PushOpts {
    all?: boolean;
    force?: boolean;
    draft?: boolean;
    direct?: boolean;
    json?: boolean;
    dryRun?: boolean;
    verbose?: boolean;
}

export function registerPushCommand(program: Command): void {
    program
        .command('push [paths...]')
        .description(`Push local files to the server. Use file paths relative to the project or brand root.

Examples:
  ef push pages/about-us.ef                     # push one page
  ef push pages/                                # push all pages under a folder
  ef push --all                                 # push every file under syncRoot
  ef push pages/login.ef pages/signup.ef        # push multiple
  ef push pages/login.ef --force                # ignore revision conflicts (overwrite)
  ef push pages/login.ef --direct               # publish (override saveMode "draft")
  ef push pages/login.ef --verbose              # explain draft vs live + each file`)
        .option('--all', 'Push every file under the brand root.')
        .option('--force', 'Skip optimistic concurrency. Use only when you mean to overwrite the server.')
        .option('--draft', 'Push as draft (overrides config "saveMode": "direct").')
        .option('--direct', 'Push as published / direct (overrides config "saveMode": "draft").')
        .option('--dry-run', 'Print what would be pushed without sending anything to the server.')
        .option('--json', 'Print results as JSON.')
        .option('-v, --verbose', 'Log API target, effective draft vs direct (publish) mode, and per-file paths.')
        .action(async (targets: string[], opts: PushOpts) => {
            if (opts.draft && opts.direct) {
                throw new CliError(ExitCode.Validation, '--draft and --direct are mutually exclusive.');
            }
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);

            const draft = opts.draft ? true : opts.direct ? false : (rt.config.saveMode === 'draft');

            if (opts.verbose && !opts.json) {
                log.detail('[verbose] ── push context ──');
                log.detail(`[verbose] API          ${rt.config.apiUrl}`);
                log.detail(`[verbose] Brand id     ${rt.config.brandId}`);
                log.detail(`[verbose] Brand root   ${rt.brandRoot}`);
                log.detail(`[verbose] saveMode     ${rt.config.saveMode} (from .ef/config.json)`);
                if (opts.draft) log.detail('[verbose] Flags        --draft (HTML saved as draft)');
                else if (opts.direct) log.detail('[verbose] Flags        --direct (HTML saved as published / live)');
                else log.detail('[verbose] Flags        (no override)');
                log.detail(
                    draft
                        ? '[verbose] HTML outcome Page/component body is sent as **draft** — not live until you publish in the app or use `ef push … --direct` (or set saveMode to "direct").'
                        : '[verbose] HTML outcome Page/component body is sent as **direct** (published) for this push.',
                );
                log.detail('[verbose] ───────────────────');
            }

            // Collect file list.
            let files: string[] = [];
            if (opts.all) {
                files = await collectAllFiles(rt.brandRoot);
            } else if (!targets || targets.length === 0) {
                throw new CliError(ExitCode.Validation, 'Pass file paths or --all. See "ef push --help".');
            } else {
                for (const t of targets) {
                    const abs = await resolveSyncPathInput(rt.brandRoot, t, rt.config.syncRoot);
                    const stat = await fs.promises.stat(abs);
                    if (stat.isDirectory()) {
                        files.push(...(await collectAllFiles(abs)));
                    } else {
                        files.push(abs);
                    }
                }
            }

            // De-dupe and sort.
            files = Array.from(new Set(files)).sort();

            // Dry-run short-circuit. We classify the file, decide what action
            // would happen, and print the plan — no API calls, no disk writes.
            if (opts.dryRun) {
                const planned: Array<{ rel: string; kind: string; action: 'create' | 'update' | 'skip' }> = [];
                for (const abs of files) {
                    const cls = classifyAbsPath(rt.brandRoot, abs);
                    if (!cls) {
                        if (!opts.json) log.warn(`would skip ${abs}: not under ${rt.brandRoot} or unknown kind.`);
                        continue;
                    }
                    if (opts.verbose && !opts.json) log.detail(`[verbose] ${abs}`);
                    const action = await predictAction(rt.brandRoot, abs, cls);
                    planned.push({ rel: cls.rel, kind: cls.kind, action });
                    if (!opts.json) {
                        const tag = action === 'create' ? c.cyan('would create')
                            : action === 'update' ? c.green('would update')
                            : c.dim('would skip  ');
                        log.info(`  ${tag} ${cls.kind} ${cls.rel}`);
                    }
                }
                if (opts.json) {
                    const payload: Record<string, unknown> = { ok: true, dryRun: true, planned };
                    if (opts.verbose) {
                        payload.debug = {
                            apiUrl: rt.config.apiUrl,
                            brandId: rt.config.brandId,
                            brandRoot: rt.brandRoot,
                            saveMode: rt.config.saveMode,
                            htmlAsDraft: draft,
                        };
                    }
                    log.json(payload);
                    return;
                }
                log.success(`Dry run: ${planned.length} file${planned.length === 1 ? '' : 's'} would be touched.`);
                return;
            }

            const results: PushResult[] = [];
            for (const abs of files) {
                const cls = classifyAbsPath(rt.brandRoot, abs);
                if (!cls) {
                    if (!opts.json) log.warn(`Skipping ${abs}: not under ${rt.brandRoot} or unknown kind.`);
                    continue;
                }
                if (opts.verbose && !opts.json) {
                    log.detail(`[verbose] ${cls.kind} ${cls.rel} ← ${abs}`);
                    if (cls.kind === 'page' || cls.kind === 'component') {
                        log.detail(`[verbose]   html draft flag: ${draft} (see push context above)`);
                    }
                }
                try {
                    let res: PushResult;
                    const v = !!(opts.verbose && !opts.json);
                    if (cls.kind === 'page') {
                        res = await pushPageFile(ctx, abs, cls.rel, { force: opts.force, draft, verbose: v });
                    } else if (cls.kind === 'component') {
                        res = await pushComponentFile(ctx, abs, cls.rel, { force: opts.force, draft, verbose: v });
                    } else if (cls.kind === 'script') {
                        res = await pushScriptFile(ctx, abs, cls.rel, { force: opts.force, verbose: v });
                    } else {
                        res = await pushAssetFile(ctx, abs, cls.rel);
                    }
                    results.push(res);
                    if (!opts.json) {
                        const tag = res.action === 'created' ? c.cyan('created')
                            : res.action === 'updated' ? c.green('updated')
                            : c.dim('noop');
                        const rev = res.revisionId ? c.dim(` rev=${res.revisionId}`) : '';
                        log.info(`  ${tag} ${res.kind} ${res.rel}${rev}`);
                        if (res.note) log.detail(`        ${res.note}`);
                        if (res.previewUrl) log.detail(`        preview: ${res.previewUrl}`);
                        if (opts.verbose) {
                            log.detail(
                                `[verbose]   server id ${res.serverId}  action ${res.action}`,
                            );
                            if (res.apiResponse && Object.keys(res.apiResponse).length > 0) {
                                log.detail('[verbose]   API response JSON:');
                                for (const line of JSON.stringify(res.apiResponse, null, 2).split('\n')) {
                                    log.detail(`[verbose]   ${line}`);
                                }
                            }
                        }
                    }
                } catch (err) {
                    if (err instanceof CliError && err.code === ExitCode.Conflict) {
                        if (opts.json) {
                            results.push({ rel: cls.rel, kind: cls.kind, action: 'noop', serverId: 0, note: `conflict: ${err.message}` });
                        } else {
                            log.error(`  conflict ${cls.kind} ${cls.rel}`);
                            log.detail(`        ${err.message}`);
                        }
                        // Keep going — push is best-effort across multiple files.
                        continue;
                    }
                    throw err;
                }
            }
            await ctx.state.save();

            if (opts.json) {
                const pushed = opts.verbose
                    ? results
                    : results.map(({ apiResponse: _omit, ...r }) => r);
                const base: Record<string, unknown> = { ok: true, pushed };
                if (opts.verbose) {
                    base.debug = {
                        apiUrl: rt.config.apiUrl,
                        brandId: rt.config.brandId,
                        brandRoot: rt.brandRoot,
                        saveMode: rt.config.saveMode,
                        htmlAsDraft: draft,
                    };
                }
                log.json(base);
                return;
            }
            log.success(`Pushed ${results.length} file${results.length === 1 ? '' : 's'}.`);
        });
}

async function predictAction(
    brandRoot: string,
    abs: string,
    cls: { kind: 'page' | 'component' | 'script' | 'asset'; rel: string },
): Promise<'create' | 'update' | 'skip'> {
    void brandRoot;
    if (cls.kind === 'asset') return 'update';
    try {
        const text = await fs.promises.readFile(abs, 'utf8');
        if (cls.kind === 'script') {
            const { parseScriptMeta } = await import('../sync/sync');
            const { meta } = parseScriptMeta(text);
            return meta && meta.id ? 'update' : 'create';
        }
        const { parseEfMeta } = await import('../sync/efMeta');
        const { meta } = parseEfMeta(text);
        if (meta && meta.id && meta.type === cls.kind) return 'update';
        return 'create';
    } catch {
        return 'skip';
    }
}

async function collectAllFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            // Always skip dotfiles/dotdirs at any depth (.ef-state.json, .git,
            // .DS_Store, .ef-state, .ef, etc.) and the standard node_modules
            // dump. Also skip our own atomic-write temp files and editor
            // backup suffixes so an interrupted save can't be re-pushed.
            if (e.name.startsWith('.')) continue;
            if (e.name === 'node_modules') continue;
            if (e.name.endsWith('~') || e.name.endsWith('.swp') || e.name.endsWith('.swo')) continue;
            if (/\.tmp-\d+-\d+(?:-[a-z0-9]+)?$/.test(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) await walk(p);
            else if (e.isFile()) out.push(p);
        }
    };
    await walk(root);
    return out;
}
