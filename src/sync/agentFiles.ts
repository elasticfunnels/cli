import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentFile, ApiClient } from '../api/client';
import { renderClaudeSection, splitGuidanceBlock } from '../commands/claude';
import { CliError, ExitCode } from '../utils/exit';
import { writeFileAtomic } from '../utils/fs';
import { hasConflictMarkers, threeWayMerge } from './merge';

/**
 * Agent files: the project instructions an AI coding tool reads, kept with the
 * brand on the server so a fresh `ef init` on another machine gets them back.
 *
 * Synced: the user's part of CLAUDE.md and every `.md`/`.mdc` under
 * `.claude/rules/`. The ef-managed block in CLAUDE.md is NOT synced: it is
 * swapped for {@link GUIDANCE_PLACEHOLDER} on the way up and for this machine's
 * own block on the way down, so a CLI version bump never shows up as an edit.
 *
 * Conflicts work like pages. `.ef/agent-files.json` holds the baseline (the
 * content and hash last agreed with the server). A push sends that hash as
 * `base_hash`; the server refuses a stale one with 409 and its own copy, and
 * the CLI 3-way merges baseline/local/server. A clean merge is pushed; an
 * overlap gets git-style markers, and a file with markers is never pushed.
 *
 * An empty file counts as absent (the server cannot store an empty string).
 */

/** Same allowlist as the server (BrandAgentFilesController::PATH_RE). */
export const AGENT_PATH_RE = /^(CLAUDE\.md|\.claude\/rules\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.mdc?)$/;

export const GUIDANCE_PLACEHOLDER = '<!-- ef:guidance (ElasticFunnels block, written by ef on each machine) -->';

const CLAUDE_MD = 'CLAUDE.md';
const RULES_DIR = path.join('.claude', 'rules');
const STATE_FILE = path.join('.ef', 'agent-files.json');
const BACKUP_DIR = path.join('.ef', 'agent-files-backup');

export function sha256(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── CLAUDE.md ⇄ synced text ──────────────────────────────────────────────

/** What gets synced for a file's on-disk text. Null = nothing worth syncing. */
export function toSynced(rel: string, text: string): string | null {
    let out = text;
    if (rel === CLAUDE_MD) {
        const split = splitGuidanceBlock(text);
        if (split) out = `${split.before}${GUIDANCE_PLACEHOLDER}${split.after}`;
        if (!out.replace(GUIDANCE_PLACEHOLDER, '').trim()) return null;
    }
    return out.trim() ? out : null;
}

/**
 * On-disk text for synced content. For CLAUDE.md the placeholder becomes the
 * block already on disk, or a fresh one when guidance is on and there is none.
 */
export function fromSynced(rel: string, synced: string, currentDisk: string, guidance: boolean): string {
    if (rel !== CLAUDE_MD) return synced;
    const block = splitGuidanceBlock(currentDisk)?.block ?? (guidance ? renderClaudeSection() : null);
    if (synced.includes(GUIDANCE_PLACEHOLDER)) {
        return block
            ? synced.replace(GUIDANCE_PLACEHOLDER, block)
            : synced.replace(`${GUIDANCE_PLACEHOLDER}\n`, '').replace(GUIDANCE_PLACEHOLDER, '');
    }
    return block ? `${synced.replace(/\s*$/, '')}\n\n${block}\n` : synced;
}

// ── Decisions (pure) ─────────────────────────────────────────────────────

export type PullAction = 'same' | 'write-server' | 'delete-local' | 'keep-local' | 'conflict';

/**
 * What a pull does with one path, given the local, server and baseline
 * content (null = absent). Mirrors page pulls: whichever side alone changed
 * since the baseline wins; both changed, or no baseline to tell, is a conflict.
 */
export function decidePull(local: string | null, server: string | null, base: string | null): PullAction {
    if (local === server) return 'same';
    if (local === null) {
        // Deleted here since the last sync and untouched there: the delete is
        // pending a push. Changed there: the server's edit beats a deletion.
        return base !== null && base === server ? 'keep-local' : 'write-server';
    }
    if (server === null) {
        // Deleted there and untouched here: follow. Edited here: keep the edit.
        return base !== null && local === base ? 'delete-local' : 'keep-local';
    }
    if (base === local) return 'write-server';
    if (base === server) return 'keep-local';
    return 'conflict';
}

// ── Disk ─────────────────────────────────────────────────────────────────

interface Baseline { hash: string; content: string }
interface StateShape { version: 1; files: Record<string, Baseline> }

export async function readBaselines(projectRoot: string): Promise<Record<string, Baseline>> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(path.join(projectRoot, STATE_FILE), 'utf8')) as StateShape;
        return parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {};
    } catch {
        return {};
    }
}

async function writeBaselines(projectRoot: string, files: Record<string, Baseline>): Promise<void> {
    const sorted: Record<string, Baseline> = {};
    for (const k of Object.keys(files).sort()) sorted[k] = files[k];
    await writeFileAtomic(path.join(projectRoot, STATE_FILE), JSON.stringify({ version: 1, files: sorted }, null, 2) + '\n');
}

async function readText(abs: string): Promise<string> {
    try { return await fs.promises.readFile(abs, 'utf8'); } catch { return ''; }
}

/**
 * Local agent files as synced text, keyed by project-relative POSIX path.
 * `ignored` lists files under .claude/rules/ the server would refuse (wrong
 * extension, odd names) so a caller can say why they did not sync.
 */
export async function readLocalAgentFiles(projectRoot: string): Promise<{ files: Map<string, string>; ignored: string[] }> {
    const files = new Map<string, string>();
    const ignored: string[] = [];

    const claude = toSynced(CLAUDE_MD, await readText(path.join(projectRoot, CLAUDE_MD)));
    if (claude !== null) files.set(CLAUDE_MD, claude);

    const walk = async (dirAbs: string): Promise<void> => {
        let entries: fs.Dirent[] = [];
        try { entries = await fs.promises.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === '.DS_Store') continue;
            const abs = path.join(dirAbs, e.name);
            if (e.isDirectory()) { await walk(abs); continue; }
            if (!e.isFile()) continue;
            if (/\.tmp-\d+-\d+(?:-[a-z0-9]+)?$/.test(e.name)) continue;
            const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
            if (!AGENT_PATH_RE.test(rel)) { ignored.push(rel); continue; }
            const synced = toSynced(rel, await readText(abs));
            if (synced !== null) files.set(rel, synced);
        }
    };
    await walk(path.join(projectRoot, RULES_DIR));
    return { files, ignored: ignored.sort() };
}

async function writeLocal(projectRoot: string, rel: string, synced: string, guidance: boolean): Promise<void> {
    const abs = path.join(projectRoot, ...rel.split('/'));
    await writeFileAtomic(abs, fromSynced(rel, synced, await readText(abs), guidance));
}

async function deleteLocal(projectRoot: string, rel: string): Promise<void> {
    const abs = path.join(projectRoot, ...rel.split('/'));
    if (rel === CLAUDE_MD) {
        // Drop the user's text, keep this machine's ef block.
        const block = splitGuidanceBlock(await readText(abs))?.block;
        if (block) { await writeFileAtomic(abs, `${block}\n`); return; }
    }
    await fs.promises.rm(abs, { force: true });
}

async function backupLocal(projectRoot: string, rel: string): Promise<string> {
    const abs = path.join(projectRoot, ...rel.split('/'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(projectRoot, BACKUP_DIR, `${rel}.${stamp}`);
    await writeFileAtomic(dest, await readText(abs));
    return path.relative(projectRoot, dest);
}

// ── Pull / push ──────────────────────────────────────────────────────────

export interface AgentSyncOptions {
    /** 3-way merge both-changed files (markers on overlap) instead of keeping local. */
    merge?: boolean;
    /** Take the server copy for both-changed files (local saved under .ef/agent-files-backup/). */
    theirs?: boolean;
    /** Whether this project writes the ef guidance block (config.aiGuidance !== false). */
    guidance?: boolean;
}

export interface AgentPullResult {
    /** Server predates the endpoint: nothing was done. */
    unsupported?: boolean;
    written: string[];
    deleted: string[];
    /** Both sides changed; local kept (no --merge / --theirs). */
    kept: string[];
    /** Merged cleanly. */
    merged: string[];
    /** Merged with conflict markers; must be resolved before a push. */
    conflicted: string[];
    backups: string[];
    ignored: string[];
}

export async function pullAgentFiles(api: ApiClient, brandId: number, projectRoot: string, opts: AgentSyncOptions = {}): Promise<AgentPullResult> {
    const result: AgentPullResult = { written: [], deleted: [], kept: [], merged: [], conflicted: [], backups: [], ignored: [] };
    const server = await api.listAgentFiles(brandId);
    if (server === null) return { ...result, unsupported: true };

    const guidance = opts.guidance !== false;
    const serverMap = new Map<string, AgentFile>(server.map((f) => [f.path, f]));
    const { files: local, ignored } = await readLocalAgentFiles(projectRoot);
    result.ignored = ignored;
    const baselines = await readBaselines(projectRoot);
    const paths = new Set([...local.keys(), ...serverMap.keys(), ...Object.keys(baselines)]);

    for (const rel of [...paths].sort()) {
        if (!AGENT_PATH_RE.test(rel)) continue;
        const l = local.get(rel) ?? null;
        const sf = serverMap.get(rel);
        const s = sf ? sf.content : null;
        const b = baselines[rel]?.content ?? null;
        const setBase = (content: string | null): void => {
            if (content === null) delete baselines[rel];
            else baselines[rel] = { hash: sha256(content), content };
        };

        switch (decidePull(l, s, b)) {
            case 'same':
                setBase(s);
                break;
            case 'write-server':
                await writeLocal(projectRoot, rel, s as string, guidance);
                setBase(s);
                result.written.push(rel);
                break;
            case 'delete-local':
                await deleteLocal(projectRoot, rel);
                setBase(null);
                result.deleted.push(rel);
                break;
            case 'keep-local':
                // Edited here, deleted there: the next push recreates it.
                if (s === null) setBase(null);
                break;
            case 'conflict': {
                if (opts.theirs) {
                    result.backups.push(await backupLocal(projectRoot, rel));
                    await writeLocal(projectRoot, rel, s as string, guidance);
                    setBase(s);
                    result.written.push(rel);
                } else if (opts.merge) {
                    const m = threeWayMerge(b ?? '', l as string, s as string, { local: 'local', server: 'server' });
                    await writeLocal(projectRoot, rel, m.merged, guidance);
                    setBase(s);
                    (m.hadConflicts ? result.conflicted : result.merged).push(rel);
                } else {
                    result.kept.push(rel);
                }
                break;
            }
        }
    }

    await writeBaselines(projectRoot, baselines);
    return result;
}

export interface AgentPushResult {
    unsupported?: boolean;
    pushed: string[];
    deleted: string[];
    /** Server changed meanwhile and the 3-way merge was clean: merged and pushed. */
    merged: string[];
    /** Overlapping edits: markers written locally, not pushed. */
    conflicted: string[];
    /** Local file still has conflict markers: refused. */
    blocked: string[];
    /** Local delete refused because the server copy changed; server copy restored. */
    restored: string[];
    ignored: string[];
}

interface PlannedWrite { path: string; content: string | null; base_hash: string | null }

/** Local changes since the baseline, as the PUT body would carry them. No network. */
export async function planAgentPush(projectRoot: string): Promise<{ writes: PlannedWrite[]; blocked: string[]; ignored: string[] }> {
    const { files: local, ignored } = await readLocalAgentFiles(projectRoot);
    const baselines = await readBaselines(projectRoot);
    const writes: PlannedWrite[] = [];
    const blocked: string[] = [];
    for (const rel of [...new Set([...local.keys(), ...Object.keys(baselines)])].sort()) {
        if (!AGENT_PATH_RE.test(rel)) continue;
        const l = local.get(rel) ?? null;
        const base = baselines[rel] ?? null;
        if (l !== null) {
            if (base && sha256(l) === base.hash) continue;
            if (hasConflictMarkers(l)) { blocked.push(rel); continue; }
            writes.push({ path: rel, content: l, base_hash: base?.hash ?? null });
        } else if (base) {
            writes.push({ path: rel, content: null, base_hash: base.hash });
        }
    }
    return { writes, blocked, ignored };
}

export async function pushAgentFiles(api: ApiClient, brandId: number, projectRoot: string, opts: AgentSyncOptions = {}): Promise<AgentPushResult> {
    const result: AgentPushResult = { pushed: [], deleted: [], merged: [], conflicted: [], blocked: [], restored: [], ignored: [] };
    const guidance = opts.guidance !== false;

    // Two rounds at most: the first may come back 409; clean merges are retried once.
    for (let round = 0; round < 2; round++) {
        const plan = await planAgentPush(projectRoot);
        result.blocked = plan.blocked;
        result.ignored = plan.ignored;
        if (plan.writes.length === 0) return result;

        const res = await api.putAgentFiles(brandId, plan.writes).catch((err) => {
            // Server predates the endpoint.
            if (err instanceof CliError && err.code === ExitCode.NotFound) return null;
            throw err;
        });
        if (res === null) return { ...result, unsupported: true };

        const baselines = await readBaselines(projectRoot);
        if (res.files) {
            for (const w of plan.writes) {
                if (w.content === null) {
                    delete baselines[w.path];
                    result.deleted.push(w.path);
                } else {
                    baselines[w.path] = { hash: sha256(w.content), content: w.content };
                    if (!result.merged.includes(w.path)) result.pushed.push(w.path);
                }
            }
            await writeBaselines(projectRoot, baselines);
            return result;
        }

        // 409: nothing was written. Resolve each conflict against the server copy.
        let retry = false;
        for (const c of res.conflicts) {
            const w = plan.writes.find((x) => x.path === c.path);
            if (!w) continue;
            const base = baselines[c.path]?.content ?? '';
            if (w.content === null) {
                // Our delete lost to a server edit: keep the server copy.
                if (c.content !== null) {
                    await writeLocal(projectRoot, c.path, c.content, guidance);
                    baselines[c.path] = { hash: sha256(c.content), content: c.content };
                    result.restored.push(c.path);
                } else {
                    delete baselines[c.path];
                }
                continue;
            }
            if (c.content === null) {
                // Deleted on the server while edited here: recreate it.
                delete baselines[c.path];
                retry = true;
                continue;
            }
            const m = threeWayMerge(base, w.content, c.content, { local: 'local', server: 'server' });
            await writeLocal(projectRoot, c.path, m.merged, guidance);
            baselines[c.path] = { hash: sha256(c.content), content: c.content };
            if (m.hadConflicts) {
                result.conflicted.push(c.path);
            } else {
                result.merged.push(c.path);
                retry = true;
            }
        }
        await writeBaselines(projectRoot, baselines);
        // A batch is all-or-nothing: retry so the non-conflicting writes land too.
        const others = plan.writes.some((w) => !res.conflicts.some((c) => c.path === w.path));
        if (!retry && !others) return result;
    }
    return result;
}
