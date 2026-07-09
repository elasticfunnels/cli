import * as path from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { Command } from 'commander';
import { c, log } from '../utils/log';
import { CliError, ExitCode } from '../utils/exit';
import { loadRuntime } from '../utils/store';
import { sha256 } from '../utils/fs';
import {
    PushResult,
    buildSyncContext,
    classifyAbsPath,
    pushAssetFile,
    pushComponentFile,
    pushPageFile,
    pushScriptFile,
} from '../sync/sync';

interface WatchOpts { draft?: boolean; direct?: boolean; debounce?: string; json?: boolean; }

/** Same skip rules as `collectAllFiles`: dotfiles, node_modules, editor backups,
 *  and our own atomic-write temp files (so the watcher never reacts to those). */
function isIgnored(p: string): boolean {
    const base = path.basename(p);
    if (base.startsWith('.')) return true;
    if (base === 'node_modules') return true;
    if (base.endsWith('~') || base.endsWith('.swp') || base.endsWith('.swo')) return true;
    if (/\.tmp-\d+-\d+(?:-[a-z0-9]+)?$/.test(base)) return true;
    return false;
}

export function registerWatchCommand(program: Command): void {
    program
        .command('watch [paths...]')
        .description('Watch the brand root and auto-push files as you save them (Ctrl-C to stop).')
        .option('--draft', 'Save changes as drafts (overrides config saveMode).')
        .option('--direct', 'Publish changes directly / live (overrides config saveMode).')
        .option('--debounce <ms>', 'Per-file debounce window in ms.', '400')
        .option('--json', 'Emit one NDJSON event per push instead of human logs.')
        .action(async (paths: string[], opts: WatchOpts) => {
            if (opts.draft && opts.direct) {
                throw new CliError(ExitCode.Validation, '--draft and --direct are mutually exclusive.');
            }
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);
            const draft = opts.draft ? true : opts.direct ? false : (rt.config.saveMode === 'draft');
            const debounceMs = Math.max(50, parseInt(opts.debounce ?? '400', 10) || 400);
            const targets = paths && paths.length
                ? paths.map((p) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)))
                : [rt.brandRoot];

            if (!opts.json) {
                log.info(`${c.bold('ef watch')} → ${rt.brandRoot}`);
                log.info(draft
                    ? `  mode: ${c.yellow('draft')} — changes are saved as drafts (not live)`
                    : `  mode: ${c.green('direct')} — changes go ${c.bold('LIVE')} on save`);
                log.detail('  Watching pages/components/scripts/assets. Press Ctrl-C to stop.');
            }

            const pending = new Map<string, NodeJS.Timeout>();
            // Hash of what we last wrote per rel, so the push's own canonical
            // write-back doesn't retrigger an endless push loop.
            const lastWroteHash = new Map<string, string>();

            const pushOne = async (kind: 'page' | 'component' | 'script' | 'asset', abs: string, rel: string): Promise<void> => {
                let buf: Buffer;
                try { buf = await fs.promises.readFile(abs); } catch { return; } // gone/unreadable
                if (lastWroteHash.get(rel) === sha256(buf)) { lastWroteHash.delete(rel); return; } // our echo
                try {
                    let res: PushResult;
                    if (kind === 'page') res = await pushPageFile(ctx, abs, rel, { draft });
                    else if (kind === 'component') res = await pushComponentFile(ctx, abs, rel, { draft });
                    else if (kind === 'script') res = await pushScriptFile(ctx, abs, rel, {});
                    else res = await pushAssetFile(ctx, abs, rel);
                    await ctx.state.save();
                    // Remember the post-push on-disk content so its change event is ignored.
                    try { lastWroteHash.set(rel, sha256(await fs.promises.readFile(abs))); } catch { /* tolerated */ }
                    if (opts.json) {
                        log.json({ event: 'pushed', rel, kind: res.kind, action: res.action, serverId: res.serverId, draft });
                    } else {
                        const verb = draft ? c.yellow('draft') : c.green(res.action === 'created' ? 'published (new)' : 'published');
                        log.info(`  ${verb} ${res.rel}`);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (opts.json) log.json({ event: 'error', rel, error: msg });
                    else log.error(`  ✗ ${rel}: ${msg}`);
                    // Keep watching — one bad push never stops the watcher.
                }
            };

            const onChange = (abs: string): void => {
                if (isIgnored(abs)) return;
                const cls = classifyAbsPath(rt.brandRoot, abs);
                if (!cls) return;
                const { kind, rel } = cls;
                clearTimeout(pending.get(rel));
                pending.set(rel, setTimeout(() => { pending.delete(rel); void pushOne(kind, abs, rel); }, debounceMs));
            };

            const watcher = chokidar.watch(targets, {
                ignoreInitial: true,
                ignored: (p: string) => isIgnored(p),
                // Wait for atomic writes (temp+rename) to settle before firing.
                awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
            });
            watcher.on('add', onChange);
            watcher.on('change', onChange);
            watcher.on('unlink', (abs: string) => {
                const cls = classifyAbsPath(rt.brandRoot, abs);
                if (!cls) return;
                if (opts.json) log.json({ event: 'deleted-local', rel: cls.rel });
                else log.detail(`  (deleted locally: ${cls.rel} — NOT removed on the server; use "ef ${cls.kind}s delete" to do that)`);
            });

            // Run until interrupted; close the watcher cleanly on Ctrl-C.
            await new Promise<void>((resolve) => {
                const shutdown = (): void => { void watcher.close().finally(() => resolve()); };
                process.on('SIGINT', shutdown);
                process.on('SIGTERM', shutdown);
            });
            if (!opts.json) log.info('\nStopped watching.');
        });
}
