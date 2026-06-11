import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import {
    buildSyncContext,
    classifyAbsPath,
    SyncContext,
} from '../sync/sync';
import { parseEfMeta } from '../sync/efMeta';
import { parseScriptMeta } from '../sync/sync';
import { sha256 } from '../utils/fs';
import { resolveSyncPathInput } from '../utils/syncPathResolve';

interface DiffOpts {
    json?: boolean;
    summary?: boolean;
}

interface DiffEntry {
    rel: string;
    kind: 'page' | 'component' | 'script' | 'asset';
    serverId: number | null;
    /**
     * - `local-only`: file on disk has no server identity (efmeta missing or
     *    server doesn't recognize the id).
     * - `clean`: local SHA-256 matches the baseline we recorded on last
     *    pull/push.
     * - `dirty`: local hash differs from the baseline (user has unsaved
     *    changes that haven't been pushed).
     * - `server-newer`: state file knows about a baseline but server's
     *    `updated_at` is later than the recorded `serverUpdatedAt`. Pull
     *    before pushing or you'll trip the revision-conflict guard.
     * - `unknown`: file is under the brand root in a known kind directory
     *    but no efmeta and no state entry — almost always a brand-new file
     *    that should be pushed via `ef push`.
     */
    status: 'local-only' | 'clean' | 'dirty' | 'server-newer' | 'unknown';
    note?: string;
}

export function registerDiffCommand(program: Command): void {
    program
        .command('diff [paths...]')
        .description(`Show drift between local files and the baselines recorded in .ef-state.json.

Without arguments, scans every page/component/script/asset under the brand
root. With arguments, restricts the scan to the given files or directories.

Examples:
  ef diff                                      # full drift report
  ef diff pages/                               # only pages
  ef diff pages/about-us.ef                    # one file (cwd or brand root)
  ef diff about-us                             # page slug shorthand
  ef diff --summary                            # counts only
  ef diff --json | jq '.[] | select(.status == "dirty")'`)
        .option('--json', 'Print drift entries as JSON.')
        .option('--summary', 'Print only the per-status counts.')
        .action(async (paths: string[], opts: DiffOpts) => {
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);

            const targets = paths && paths.length > 0
                ? await collectTargets(rt.brandRoot, rt.config.syncRoot, paths)
                : await collectAll(rt.brandRoot);

            const results: DiffEntry[] = [];
            for (const abs of targets) {
                const cls = classifyAbsPath(rt.brandRoot, abs);
                if (!cls) continue;
                const entry = await classify(ctx, abs, cls);
                results.push(entry);
            }

            if (opts.summary) {
                const counts = countByStatus(results);
                if (opts.json) { log.json({ ok: true, total: results.length, counts }); return; }
                log.info(`${c.bold('Drift summary')}  total=${results.length}`);
                for (const [status, n] of Object.entries(counts)) {
                    log.info(`  ${formatStatus(status as DiffEntry['status'])}  ${n}`);
                }
                return;
            }

            if (opts.json) { log.json(results); return; }

            const dirty = results.filter(r => r.status !== 'clean');
            if (dirty.length === 0) {
                log.success(`No drift across ${results.length} files. Local copies match recorded baselines.`);
                return;
            }
            for (const r of dirty) {
                log.info(`  ${formatStatus(r.status)}  ${r.kind} ${r.rel}${r.note ? c.dim(`  (${r.note})`) : ''}`);
            }
            const counts = countByStatus(results);
            log.detail(`scanned=${results.length}  dirty=${counts.dirty ?? 0}  local-only=${counts['local-only'] ?? 0}  server-newer=${counts['server-newer'] ?? 0}  unknown=${counts.unknown ?? 0}`);
        });
}

function countByStatus(results: DiffEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return counts;
}

function formatStatus(s: DiffEntry['status']): string {
    switch (s) {
        case 'clean': return c.green('clean       ');
        case 'dirty': return c.yellow('dirty       ');
        case 'local-only': return c.cyan('local-only  ');
        case 'server-newer': return c.red('server-newer');
        case 'unknown': return c.dim('unknown     ');
    }
}

async function classify(
    ctx: SyncContext,
    abs: string,
    cls: { kind: 'page' | 'component' | 'script' | 'asset'; rel: string },
): Promise<DiffEntry> {
    const stateEntry = ctx.state.getByPath(cls.kind, cls.rel);
    if (cls.kind === 'asset') {
        const bytes = await fs.promises.readFile(abs);
        const hash = sha256(bytes);
        if (!stateEntry) {
            return { rel: cls.rel, kind: cls.kind, serverId: null, status: 'unknown', note: 'no state entry' };
        }
        const status = stateEntry.contentHash === hash ? 'clean' : 'dirty';
        return { rel: cls.rel, kind: cls.kind, serverId: stateEntry.id, status };
    }

    const text = await fs.promises.readFile(abs, 'utf8');
    const parsed = cls.kind === 'script' ? parseScriptMeta(text) : parseEfMeta(text);
    const meta = parsed.meta;
    const body = parsed.body;
    const hash = sha256(Buffer.from(body, 'utf8'));

    if (!meta || !meta.id) {
        if (!stateEntry) {
            return { rel: cls.rel, kind: cls.kind, serverId: null, status: 'unknown', note: 'no efmeta, no state entry' };
        }
        // State entry exists but file lost its meta — still treat as "dirty"
        // because pushing it would re-allocate a new server id.
        return { rel: cls.rel, kind: cls.kind, serverId: stateEntry.id, status: 'local-only', note: 'efmeta header missing' };
    }
    if (!stateEntry) {
        return { rel: cls.rel, kind: cls.kind, serverId: meta.id, status: 'unknown', note: 'no state entry, has efmeta' };
    }
    if (stateEntry.contentHash !== hash) {
        return { rel: cls.rel, kind: cls.kind, serverId: meta.id, status: 'dirty' };
    }
    // For pages/components/scripts, also flag when server has moved past us.
    const remoteUpdated = meta.remoteUpdatedAt ? Date.parse(meta.remoteUpdatedAt) : NaN;
    const baselineUpdated = stateEntry.serverUpdatedAt ? Date.parse(stateEntry.serverUpdatedAt) : NaN;
    if (Number.isFinite(remoteUpdated) && Number.isFinite(baselineUpdated) && remoteUpdated > baselineUpdated) {
        return { rel: cls.rel, kind: cls.kind, serverId: meta.id, status: 'server-newer' };
    }
    return { rel: cls.rel, kind: cls.kind, serverId: meta.id, status: 'clean' };
}

async function collectAll(brandRoot: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            if (e.name === 'node_modules') continue;
            if (e.name.endsWith('~') || e.name.endsWith('.swp') || e.name.endsWith('.swo')) continue;
            if (/\.tmp-\d+-\d+(?:-[a-z0-9]+)?$/.test(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) await walk(p);
            else if (e.isFile()) out.push(p);
        }
    };
    await walk(brandRoot);
    return out;
}

async function collectTargets(brandRoot: string, syncRoot: string, paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const p of paths) {
        const abs = await resolveSyncPathInput(brandRoot, p, syncRoot);
        const stat = await fs.promises.stat(abs);
        if (stat.isDirectory()) out.push(...(await collectAll(abs)));
        else out.push(abs);
    }
    return out;
}
