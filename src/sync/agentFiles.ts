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

// ── Path safety ──────────────────────────────────────────────────────────

/**
 * Refuse a project-relative path whose any existing component is a symbolic
 * link, or that resolves outside the project. A committed `CLAUDE.md` linked
 * to `~/.aws/credentials` would otherwise be uploaded by a teammate's push,
 * and a linked `.claude/rules` would let a pull write anywhere on the disk.
 * Returns the reason, or null when the path is safe.
 */
export async function unsafeAgentPath(projectRoot: string, rel: string): Promise<string | null> {
    const parts = rel.split('/').filter(Boolean);
    let cur = projectRoot;
    let deepest = projectRoot;
    for (const part of parts) {
        cur = path.join(cur, part);
        let st: fs.Stats;
        try {
            st = await fs.promises.lstat(cur);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
            throw err;
        }
        const relCur = path.relative(projectRoot, cur).split(path.sep).join('/');
        if (st.isSymbolicLink()) return `${relCur} is a symbolic link`;
        if (relCur !== rel && !st.isDirectory()) return `${relCur} is not a directory`;
        deepest = cur;
    }
    const rootReal = await fs.promises.realpath(projectRoot);
    const real = await fs.promises.realpath(deepest);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return `${rel} resolves outside the project`;
    return null;
}

/** True when `rel` is a refused path or lies under a refused directory. */
export function isRefused(refused: string[], rel: string): boolean {
    return refused.some((r) => rel === r || rel.startsWith(`${r}/`));
}

async function assertSafe(projectRoot: string, rel: string): Promise<void> {
    const why = await unsafeAgentPath(projectRoot, rel);
    if (why) throw new CliError(ExitCode.Validation, `Refusing ${rel}: ${why}.`);
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
        if (await unsafeAgentPath(projectRoot, '.ef/agent-files.json')) return {};
        const parsed = JSON.parse(await fs.promises.readFile(path.join(projectRoot, STATE_FILE), 'utf8')) as StateShape;
        return parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {};
    } catch {
        return {};
    }
}

async function writeBaselines(projectRoot: string, files: Record<string, Baseline>): Promise<void> {
    const sorted: Record<string, Baseline> = {};
    for (const k of Object.keys(files).sort()) sorted[k] = files[k];
    await assertSafe(projectRoot, '.ef/agent-files.json');
    await writeFileAtomic(path.join(projectRoot, STATE_FILE), JSON.stringify({ version: 1, files: sorted }, null, 2) + '\n');
}

async function readText(abs: string): Promise<string> {
    try { return await fs.promises.readFile(abs, 'utf8'); } catch { return ''; }
}

/**
 * Local agent files as synced text, keyed by project-relative POSIX path.
 * `ignored` lists files under .claude/rules/ the server would refuse (wrong
 * extension, odd names) so a caller can say why they did not sync.
 * `refused` lists symbolic links (a file, or `.claude` / `.claude/rules`
 * itself): never read, never written, never deleted on the brand.
 */
export async function readLocalAgentFiles(projectRoot: string): Promise<{ files: Map<string, string>; ignored: string[]; refused: string[] }> {
    const files = new Map<string, string>();
    const ignored: string[] = [];
    const refused: string[] = [];

    if (await unsafeAgentPath(projectRoot, CLAUDE_MD)) {
        refused.push(CLAUDE_MD);
    } else {
        const claude = toSynced(CLAUDE_MD, await readText(path.join(projectRoot, CLAUDE_MD)));
        if (claude !== null) files.set(CLAUDE_MD, claude);
    }

    const walk = async (dirAbs: string): Promise<void> => {
        let entries: fs.Dirent[] = [];
        try { entries = await fs.promises.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === '.DS_Store') continue;
            const abs = path.join(dirAbs, e.name);
            const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
            // Dirent types come from lstat: a link is neither a file nor a directory.
            if (e.isSymbolicLink()) { refused.push(rel); continue; }
            if (e.isDirectory()) { await walk(abs); continue; }
            if (!e.isFile()) continue;
            if (/\.tmp-\d+-\d+(?:-[a-z0-9]+)?$/.test(e.name)) continue;
            if (!AGENT_PATH_RE.test(rel)) { ignored.push(rel); continue; }
            const synced = toSynced(rel, await readText(abs));
            if (synced !== null) files.set(rel, synced);
        }
    };
    const rulesRel = RULES_DIR.split(path.sep).join('/');
    const rulesWhy = await unsafeAgentPath(projectRoot, rulesRel);
    if (rulesWhy) {
        // `.claude` or `.claude/rules` is a link: refuse everything under it.
        refused.push(rulesWhy.startsWith('.claude ') ? '.claude' : rulesRel);
    } else {
        await walk(path.join(projectRoot, RULES_DIR));
    }
    return { files, ignored: ignored.sort(), refused: refused.sort() };
}

/** On-disk text a write of `synced` would leave at `rel`. */
async function nextDiskText(projectRoot: string, rel: string, synced: string, guidance: boolean): Promise<string> {
    return fromSynced(rel, synced, await readText(path.join(projectRoot, ...rel.split('/'))), guidance);
}

async function writeLocal(projectRoot: string, rel: string, synced: string, guidance: boolean): Promise<void> {
    await assertSafe(projectRoot, rel);
    const abs = path.join(projectRoot, ...rel.split('/'));
    await writeFileAtomic(abs, await nextDiskText(projectRoot, rel, synced, guidance));
}

/** On-disk text a delete would leave at `rel` (null = file removed). */
async function afterDelete(projectRoot: string, rel: string): Promise<string | null> {
    if (rel !== CLAUDE_MD) return null;
    const block = splitGuidanceBlock(await readText(path.join(projectRoot, CLAUDE_MD)))?.block;
    return block ? `${block}\n` : null;
}

async function deleteLocal(projectRoot: string, rel: string): Promise<void> {
    await assertSafe(projectRoot, rel);
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
    await assertSafe(projectRoot, rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destRel = `${BACKUP_DIR.split(path.sep).join('/')}/${rel}.${stamp}`;
    await assertSafe(projectRoot, destRel);
    const dest = path.join(projectRoot, ...destRel.split('/'));
    await writeFileAtomic(dest, await readText(abs));
    return path.relative(projectRoot, dest);
}

// ── Pull / push ──────────────────────────────────────────────────────────

/** One change a pull would make on disk, for review before it is written. */
export interface AgentPullChange {
    path: string;
    action: 'write' | 'delete' | 'theirs' | 'merge' | 'merge-markers';
    /** On-disk text now (null = absent). */
    before: string | null;
    /** On-disk text after the change (null = file removed). */
    after: string | null;
}

export interface AgentSyncOptions {
    /** 3-way merge both-changed files (markers on overlap) instead of keeping local. */
    merge?: boolean;
    /** Take the server copy for both-changed files (local saved under .ef/agent-files-backup/). */
    theirs?: boolean;
    /** Whether this project writes the ef guidance block (config.aiGuidance !== false). */
    guidance?: boolean;
    /**
     * Agent files are instructions a coding agent obeys, so a pull never
     * writes them unasked. Called with every pending change (from one server
     * read); only a `true` answer writes them. Absent = write nothing and
     * return the changes in `pending` (what `ef pull` / `ef init` do).
     */
    confirm?: (changes: AgentPullChange[]) => Promise<boolean>;
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
    /** Symbolic links (or paths under one): skipped, never followed. */
    refused: string[];
    /** Changes found but not written (no confirm, or declined). */
    pending: AgentPullChange[];
}

export async function pullAgentFiles(api: ApiClient, brandId: number, projectRoot: string, opts: AgentSyncOptions = {}): Promise<AgentPullResult> {
    const result: AgentPullResult = { written: [], deleted: [], kept: [], merged: [], conflicted: [], backups: [], ignored: [], refused: [], pending: [] };
    const server = await api.listAgentFiles(brandId);
    if (server === null) return { ...result, unsupported: true };

    const guidance = opts.guidance !== false;
    const serverMap = new Map<string, AgentFile>(server.map((f) => [f.path, f]));
    const { files: local, ignored, refused } = await readLocalAgentFiles(projectRoot);
    result.ignored = ignored;
    const baselines = await readBaselines(projectRoot);
    const paths = new Set([...local.keys(), ...serverMap.keys(), ...Object.keys(baselines)]);
    const diskOf = async (rel: string): Promise<string | null> => {
        try { return await fs.promises.readFile(path.join(projectRoot, ...rel.split('/')), 'utf8'); } catch { return null; }
    };
    const setBase = (rel: string, content: string | null): void => {
        if (content === null) delete baselines[rel];
        else baselines[rel] = { hash: sha256(content), content };
    };

    // Plan first: nothing below touches an agent file until confirmed.
    interface Step { change: AgentPullChange; base: string | null; synced: string | null; markers?: boolean }
    const steps: Step[] = [];
    for (const rel of [...paths].sort()) {
        if (!AGENT_PATH_RE.test(rel)) continue;
        if (isRefused(refused, rel) || await unsafeAgentPath(projectRoot, rel)) { result.refused.push(rel); continue; }
        const l = local.get(rel) ?? null;
        const sf = serverMap.get(rel);
        const s = sf ? sf.content : null;
        const b = baselines[rel]?.content ?? null;
        const before = await diskOf(rel);

        switch (decidePull(l, s, b)) {
            case 'same':
                setBase(rel, s);
                break;
            case 'write-server':
                steps.push({ change: { path: rel, action: 'write', before, after: await nextDiskText(projectRoot, rel, s as string, guidance) }, base: s, synced: s });
                break;
            case 'delete-local':
                steps.push({ change: { path: rel, action: 'delete', before, after: await afterDelete(projectRoot, rel) }, base: null, synced: null });
                break;
            case 'keep-local':
                // Edited here, deleted there: the next push recreates it.
                if (s === null) setBase(rel, null);
                break;
            case 'conflict': {
                if (opts.theirs) {
                    steps.push({ change: { path: rel, action: 'theirs', before, after: await nextDiskText(projectRoot, rel, s as string, guidance) }, base: s, synced: s });
                } else if (opts.merge) {
                    const m = threeWayMerge(b ?? '', l as string, s as string, { local: 'local', server: 'server' });
                    steps.push({
                        change: { path: rel, action: m.hadConflicts ? 'merge-markers' : 'merge', before, after: await nextDiskText(projectRoot, rel, m.merged, guidance) },
                        base: s, synced: m.merged, markers: m.hadConflicts,
                    });
                } else {
                    result.kept.push(rel);
                }
                break;
            }
        }
    }
    result.refused = [...new Set([...result.refused, ...refused])].sort();

    const changes = steps.map((x) => x.change);
    const go = changes.length > 0 && opts.confirm ? await opts.confirm(changes) : false;
    if (!go) {
        result.pending = changes;
        await writeBaselines(projectRoot, baselines);
        return result;
    }

    for (const st of steps) {
        const rel = st.change.path;
        switch (st.change.action) {
            case 'write':
                await writeLocal(projectRoot, rel, st.synced as string, guidance);
                result.written.push(rel);
                break;
            case 'delete':
                await deleteLocal(projectRoot, rel);
                result.deleted.push(rel);
                break;
            case 'theirs':
                result.backups.push(await backupLocal(projectRoot, rel));
                await writeLocal(projectRoot, rel, st.synced as string, guidance);
                result.written.push(rel);
                break;
            case 'merge':
            case 'merge-markers':
                await writeLocal(projectRoot, rel, st.synced as string, guidance);
                (st.markers ? result.conflicted : result.merged).push(rel);
                break;
        }
        setBase(rel, st.base);
    }

    await writeBaselines(projectRoot, baselines);
    return result;
}

export interface AgentPushResult {
    unsupported?: boolean;
    pushed: string[];
    deleted: string[];
    /**
     * Changed on the brand since the last sync: nothing written here or there.
     * Review with `ef claude pull` (diff + confirm, `--merge` to merge), then push.
     * A push never writes the brand's text into local files on its own.
     */
    stale: string[];
    /** Local file still has conflict markers: refused. */
    blocked: string[];
    ignored: string[];
    /** Symbolic links (or paths under one): never read, never uploaded, never deleted on the brand. */
    refused: string[];
}

interface PlannedWrite { path: string; content: string | null; base_hash: string | null }

/** Local changes since the baseline, as the PUT body would carry them. No network. */
export async function planAgentPush(projectRoot: string): Promise<{ writes: PlannedWrite[]; blocked: string[]; ignored: string[]; refused: string[] }> {
    const { files: local, ignored, refused } = await readLocalAgentFiles(projectRoot);
    const baselines = await readBaselines(projectRoot);
    const writes: PlannedWrite[] = [];
    const blocked: string[] = [];
    for (const rel of [...new Set([...local.keys(), ...Object.keys(baselines)])].sort()) {
        if (!AGENT_PATH_RE.test(rel)) continue;
        // A link reads as "absent": never turn that into a delete on the brand.
        if (isRefused(refused, rel)) continue;
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
    return { writes, blocked, ignored, refused };
}

export async function pushAgentFiles(api: ApiClient, brandId: number, projectRoot: string, _opts: AgentSyncOptions = {}): Promise<AgentPushResult> {
    const result: AgentPushResult = { pushed: [], deleted: [], stale: [], blocked: [], ignored: [], refused: [] };
    const skip = new Set<string>();

    // Two rounds at most: a 409 refuses the whole batch, so the files that did
    // not conflict are sent again without the stale ones.
    for (let round = 0; round < 2; round++) {
        const plan = await planAgentPush(projectRoot);
        result.blocked = plan.blocked;
        result.ignored = plan.ignored;
        result.refused = plan.refused;
        const writes = plan.writes.filter((w) => !skip.has(w.path));
        if (writes.length === 0) return result;

        const res = await api.putAgentFiles(brandId, writes).catch((err) => {
            // Server predates the endpoint.
            if (err instanceof CliError && err.code === ExitCode.NotFound) return null;
            throw err;
        });
        if (res === null) return { ...result, unsupported: true };

        const baselines = await readBaselines(projectRoot);
        if (res.files) {
            for (const w of writes) {
                if (w.content === null) {
                    delete baselines[w.path];
                    result.deleted.push(w.path);
                } else {
                    baselines[w.path] = { hash: sha256(w.content), content: w.content };
                    result.pushed.push(w.path);
                }
            }
            await writeBaselines(projectRoot, baselines);
            return result;
        }

        // 409: nothing was written. Local files are left exactly as they are.
        for (const c of res.conflicts) {
            if (!writes.some((w) => w.path === c.path)) continue;
            skip.add(c.path);
            if (!result.stale.includes(c.path)) result.stale.push(c.path);
        }
        if (!writes.some((w) => !skip.has(w.path))) return result;
    }
    return result;
}
