// 3-way merge + unified diff, used by `ef pull --merge` and `ef diff --server`.
// Prefers `git merge-file` (hunk-level, battle-tested, git-style markers); falls
// back to a whole-file conflict when git isn't on PATH and both sides changed.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let gitChecked: boolean | null = null;
export function hasGit(): boolean {
    if (gitChecked !== null) return gitChecked;
    try {
        gitChecked = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
    } catch {
        gitChecked = false;
    }
    return gitChecked;
}

let counter = 0;
function tmpFile(tag: string, content: string): string {
    const p = path.join(os.tmpdir(), `ef-merge-${process.pid}-${Date.now()}-${counter++}-${tag}`);
    fs.writeFileSync(p, content);
    return p;
}
function rm(...files: string[]): void {
    for (const f of files) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

export interface MergeResult { merged: string; hadConflicts: boolean; }

/**
 * 3-way merge. base = common ancestor, local = on-disk edit, server = incoming.
 * Clean auto-merges (only one side changed a hunk) resolve silently; overlapping
 * edits produce git-style `<<<<<<< local / ======= / >>>>>>> server` markers.
 */
export function threeWayMerge(base: string, local: string, server: string, labels: { local?: string; server?: string } = {}): MergeResult {
    const localLabel = labels.local ?? 'local';
    const serverLabel = labels.server ?? 'server';
    if (local === server) return { merged: local, hadConflicts: false };
    if (local === base) return { merged: server, hadConflicts: false }; // only server changed → take server
    if (server === base) return { merged: local, hadConflicts: false }; // only local changed → keep local

    if (hasGit()) {
        const lf = tmpFile('local', local);
        const bf = tmpFile('base', base);
        const sf = tmpFile('server', server);
        try {
            const r = spawnSync('git', ['merge-file', '-p', '-L', localLabel, '-L', 'base', '-L', serverLabel, lf, bf, sf], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            // exit 0 = clean; >0 = number of conflict hunks; <0 = git error (fall through).
            if (typeof r.status === 'number' && r.status >= 0) {
                return { merged: r.stdout ?? '', hadConflicts: r.status > 0 };
            }
        } finally {
            rm(lf, bf, sf);
        }
    }
    return { merged: wholeFileConflict(local, server, localLabel, serverLabel), hadConflicts: true };
}

function wholeFileConflict(local: string, server: string, localLabel: string, serverLabel: string): string {
    const nl = local.endsWith('\n') || local === '' ? '' : '\n';
    const ns = server.endsWith('\n') || server === '' ? '' : '\n';
    return `<<<<<<< ${localLabel}\n${local}${nl}=======\n${server}${ns}>>>>>>> ${serverLabel}\n`;
}

/** True when a body carries unresolved git-style conflict markers. */
export function hasConflictMarkers(text: string): boolean {
    return /^<{7}[ \t]/m.test(text) && /^={7}\s*$/m.test(text) && /^>{7}[ \t]/m.test(text);
}

/** Unified diff (git diff --no-index when available; a coarse fallback otherwise). */
export function unifiedDiff(a: string, b: string, labelA = 'local', labelB = 'server'): string {
    if (a === b) return '';
    if (hasGit()) {
        const af = tmpFile('a', a);
        const bf = tmpFile('b', b);
        try {
            const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', af, bf], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            const out = (r.stdout ?? '').replace(new RegExp(af.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), labelA).replace(new RegExp(bf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), labelB);
            if (out.trim()) return out;
        } finally {
            rm(af, bf);
        }
    }
    // Coarse fallback: mark removed then added lines.
    const rmLines = a.split('\n').map((l) => `- ${l}`).join('\n');
    const addLines = b.split('\n').map((l) => `+ ${l}`).join('\n');
    return `--- ${labelA}\n+++ ${labelB}\n${rmLines}\n${addLines}\n`;
}
