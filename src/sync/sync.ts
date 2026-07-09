import * as path from 'path';
import * as fs from 'fs';
import { ApiClient } from '../api/client';
import { EfRuntime } from '../utils/store';
import { SyncStateFile } from '../sync/stateFile';
import { EfMeta, parseEfMeta, serializeEfMeta, serializeScriptEfMeta, withEfMeta } from '../sync/efMeta';
import { CliError, ExitCode } from '../utils/exit';
import { fileExists, readFileBytes, sha256, writeFileAtomic } from '../utils/fs';
import { DEFAULT_PULL_CONCURRENCY, mapWithConcurrency } from '../utils/concurrency';
import {
    relPathForAsset,
    relPathForComponent,
    relPathForPage,
    relPathForScript,
    safeJoinBrandRoot,
} from './paths';
import { assetEditorPayloadToBuffer, needsLocalAssetFallback } from '../api/types';
import { log } from '../utils/log';

const VERBOSE_BODY_FULL_MAX = 8000;
const VERBOSE_BODY_HEAD = 1400;
const VERBOSE_BODY_TAIL = 700;

/** Log the exact markup/source we send on POST (after efmeta strip). */
function verboseLogOutgoingBody(rel: string, body: string, endpointHint: string): void {
    const bytes = Buffer.byteLength(body, 'utf8');
    const hash = sha256(Buffer.from(body, 'utf8'));
    log.detail(`[verbose]   Outgoing ${endpointHint} — ${rel}`);
    log.detail(`[verbose]   Body: ${bytes} bytes (UTF-8), sha256=${hash}`);
    if (body.length <= VERBOSE_BODY_FULL_MAX) {
        log.detail('[verbose]   —— body (full) ——');
        for (const line of body.split('\n')) {
            log.detail(`[verbose]   ${line}`);
        }
        log.detail('[verbose]   —— end body ——');
        return;
    }
    const head = body.slice(0, VERBOSE_BODY_HEAD);
    const tail = body.slice(-VERBOSE_BODY_TAIL);
    log.detail(`[verbose]   —— body head (${VERBOSE_BODY_HEAD} chars) ——`);
    for (const line of head.split('\n')) {
        log.detail(`[verbose]   ${line}`);
    }
    log.detail(`[verbose]   … (${body.length - VERBOSE_BODY_HEAD - VERBOSE_BODY_TAIL} chars omitted) …`);
    log.detail(`[verbose]   —— body tail (${VERBOSE_BODY_TAIL} chars) ——`);
    for (const line of tail.split('\n')) {
        log.detail(`[verbose]   ${line}`);
    }
    log.detail('[verbose]   —— end body ——');
}

/** Shallow copy of API JSON for logs / --verbose; drops huge HTML payloads. */
function shrinkPushApiBody(body: unknown): Record<string, unknown> | undefined {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const src = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
        if ((k === 'html' || k === 'server_html') && typeof v === 'string' && v.length > 500) {
            out[k] = `[${v.length} chars]`;
        } else {
            out[k] = v as unknown;
        }
    }
    return out;
}

/** Reusable bundle of the things every sync helper needs. */
export interface SyncContext {
    rt: EfRuntime;
    api: ApiClient;
    state: SyncStateFile;
    /** Optional per-item progress hook for full syncs (label = brand-root-relative path). */
    onProgress?: (kind: 'page' | 'component' | 'script' | 'asset', label: string, done: number, total: number) => void;
}

/**
 * Pull a list of entities with bounded concurrency, tolerating per-item
 * failures (a single 404 from a stale entity must not abort the whole sync).
 * Emits progress and warns once about any skipped items.
 */
async function pullEach<T>(
    ctx: SyncContext,
    kind: 'page' | 'component' | 'script' | 'asset',
    items: T[],
    pull: (item: T) => Promise<{ rel: string; skipped?: boolean } | null>,
): Promise<Array<{ rel: string; skipped?: boolean }>> {
    const total = items.length;
    let done = 0;
    const failures: string[] = [];
    const out = await mapWithConcurrency(items, DEFAULT_PULL_CONCURRENCY, async (item) => {
        try {
            const r = await pull(item);
            done++;
            if (r) ctx.onProgress?.(kind, r.rel, done, total);
            return r;
        } catch (err) {
            done++;
            failures.push(err instanceof Error ? err.message : String(err));
            ctx.onProgress?.(kind, `(skipped a ${kind})`, done, total);
            return null;
        }
    });
    if (failures.length) {
        const { log } = await import('../utils/log');
        log.warn(`Skipped ${failures.length} ${kind}${failures.length === 1 ? '' : 's'} that failed to pull (e.g. deleted on the server). First error: ${failures[0]}`);
    }
    return out.filter((r): r is { rel: string; skipped?: boolean } => r != null).map((r) => ({ rel: r.rel, skipped: r.skipped }));
}

/**
 * Adopt check for `ef init` on an already-synced folder (e.g. one the VS Code
 * extension populated): an entity is already on disk and unchanged when its
 * tracked local file exists and its body hash matches the recorded contentHash,
 * so init can skip re-downloading it. Assets are adopted on existence alone
 * (they're the heaviest to re-fetch and rarely change). Returns the rel to skip,
 * or null to fetch.
 */
async function alreadyOnDisk(ctx: SyncContext, kind: 'page' | 'component' | 'script' | 'asset', id: number): Promise<{ rel: string } | null> {
    const st = ctx.state.getById(kind, id);
    if (!st) return null;
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, st.path);
    if (!(await fileExists(abs))) return null;
    if (kind === 'asset') return { rel: st.path };
    if (!st.contentHash) return null;
    try {
        const text = await fs.promises.readFile(abs, 'utf8');
        const body = kind === 'script' ? parseScriptMeta(text).body : parseEfMeta(text).body;
        if (sha256(Buffer.from(body, 'utf8')) === st.contentHash) return { rel: st.path };
    } catch { /* unreadable → fetch */ }
    return null;
}

/**
 * Tracks state files we've already warned about during this process so
 * a single CLI invocation never spams the same warning twice (e.g. when
 * commands construct a context multiple times).
 */
const warnedStateFiles = new Set<string>();

export async function buildSyncContext(rt: EfRuntime): Promise<SyncContext> {
    const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
    const state = await SyncStateFile.load(rt.brandRoot, rt.config.brandId);
    if (state.brandId !== rt.config.brandId) state.setBrandId(rt.config.brandId);
    if (state.isVersionTooNew() && !warnedStateFiles.has(state.statePath)) {
        warnedStateFiles.add(state.statePath);
        // Lazy-import to avoid a cycle with `utils/log` callers.
        const { log } = await import('../utils/log');
        log.warn(
            `.ef-state.json at ${state.statePath} was written by a newer CLI ` +
            `(schema v${state.getLoadedVersion()}, this CLI understands v${SyncStateFile.STATE_VERSION}). ` +
            `Sync will run but local state will NOT be updated. Upgrade with: npm i -g @elasticfunnels/cli@latest`,
        );
    }
    return { rt, api, state };
}

// ── Pages ────────────────────────────────────────────────────────────

/**
 * Pull-collision guard. If `rel` is already occupied on disk by a DIFFERENT
 * entity (its efmeta id ≠ `id`) — which happens when two server entities share a
 * code/slug — return an id-suffixed path so the pull doesn't clobber the first,
 * and warn. The disambiguated file still carries the correct efmeta id, so a
 * later push targets the right entity regardless of the filename.
 */
export async function nonCollidingRel(ctx: SyncContext, rel: string, id: number, kind: 'page' | 'component'): Promise<string> {
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);
    if (!(await fileExists(abs))) return rel;
    let existingId: number | undefined;
    try { existingId = parseEfMeta(await fs.promises.readFile(abs, 'utf8')).meta?.id; } catch { /* unreadable → treat as free */ }
    if (existingId == null || existingId === id) return rel;
    const alt = rel.replace(/\.ef$/, `-${id}.ef`);
    log.warn(`${kind} path collision: #${existingId} and #${id} both map to "${rel}" (duplicate code/slug on the server?). Writing #${id} to "${alt}".`);
    return alt;
}

/**
 * Local-overwrite guard. Returns true when pulling would clobber unpushed local
 * edits: the local file exists, its body differs from the incoming server body,
 * AND the local body has drifted from the last-pulled baseline (or there's no
 * baseline to trust). Callers then keep the local file and warn instead of
 * overwriting. `force` bypasses. When the local body still matches the baseline
 * (no local edits), a normal server refresh is safe → returns false.
 */
async function wouldClobberLocalEdits(ctx: SyncContext, kind: 'page' | 'component' | 'script', rel: string, serverBody: string, force?: boolean): Promise<boolean> {
    if (force) return false;
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);
    if (!(await fileExists(abs))) return false;
    let localBody: string;
    try {
        const text = await fs.promises.readFile(abs, 'utf8');
        localBody = kind === 'script' ? parseScriptMeta(text).body : parseEfMeta(text).body;
    } catch { return false; }
    if (localBody === serverBody) return false; // identical — nothing to lose
    const baseline = ctx.state.getByPath(kind, rel)?.contentHash;
    if (baseline && sha256(Buffer.from(localBody, 'utf8')) === baseline) return false; // local unchanged since last pull → safe
    return true; // local edited (or unknown baseline) and differs from server → protect
}

export async function pullPage(ctx: SyncContext, pageId: number, opts: { force?: boolean } = {}): Promise<{ rel: string; absPath: string; created: boolean; skipped?: string }> {
    const page = await ctx.api.getPageContent(ctx.rt.config.brandId, pageId);
    const rel = await nonCollidingRel(ctx, relPathForPage(page), page.id, 'page');
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);
    const meta: EfMeta = {
        v: 1,
        type: 'page',
        brandId: ctx.rt.config.brandId,
        id: page.id,
        slug: page.slug ?? undefined,
        name: page.title ?? undefined,
        revisionId: page.revision_id ?? undefined,
        remoteUpdatedAt: page.updated_at ?? undefined,
        path: rel,
    };
    const body = page.html ?? '';
    if (await wouldClobberLocalEdits(ctx, 'page', rel, body, opts.force)) {
        log.warn(`Kept local ${rel} — it has changes not on the server. Push them ("ef push ${rel}"), or re-pull with --force to overwrite (a copy is saved to .ef-history).`);
        return { rel, absPath: abs, created: false, skipped: 'local-drift' };
    }
    const file = withEfMeta(meta, body);
    const existed = await fileExists(abs);
    await snapshotToHistory(ctx.rt.brandRoot, rel, file);
    await writeFileAtomic(abs, file);

    ctx.state.setEntry('page', {
        path: rel,
        id: page.id,
        type: 'page',
        revisionId: page.revision_id ?? null,
        updatedAt: page.updated_at ?? null,
        serverUpdatedAt: page.updated_at ?? null,
        contentHash: sha256(Buffer.from(body, 'utf8')),
    });
    return { rel, absPath: abs, created: !existed };
}

export async function pullAllPages(ctx: SyncContext, opts: { adopt?: boolean; force?: boolean } = {}): Promise<Array<{ rel: string; skipped?: boolean }>> {
    const pages = await ctx.api.listPages(ctx.rt.config.brandId);
    return await pullEach(ctx, 'page', pages, async (p) => {
        if (opts.adopt) { const hit = await alreadyOnDisk(ctx, 'page', p.id); if (hit) return { rel: hit.rel, skipped: true }; }
        const r = await pullPage(ctx, p.id, { force: opts.force });
        return { rel: r.rel, skipped: !!r.skipped };
    });
}

// ── Components ───────────────────────────────────────────────────────

export async function pullComponent(ctx: SyncContext, componentId: number, opts: { force?: boolean } = {}): Promise<{ rel: string; absPath: string; created: boolean; skipped?: string }> {
    const c = await ctx.api.getComponentContent(ctx.rt.config.brandId, componentId);
    const rel = await nonCollidingRel(ctx, relPathForComponent(c), c.id, 'component');
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);
    const meta: EfMeta = {
        v: 1,
        type: 'component',
        brandId: ctx.rt.config.brandId,
        id: c.id,
        slug: c.code ?? undefined,
        name: c.name ?? undefined,
        revisionId: c.revision_id ?? undefined,
        remoteUpdatedAt: c.updated_at ?? undefined,
        path: rel,
    };
    const body = c.html ?? '';
    if (await wouldClobberLocalEdits(ctx, 'component', rel, body, opts.force)) {
        log.warn(`Kept local ${rel} — it has changes not on the server. Push them ("ef push ${rel}"), or re-pull with --force to overwrite (a copy is saved to .ef-history).`);
        return { rel, absPath: abs, created: false, skipped: 'local-drift' };
    }
    const existed = await fileExists(abs);
    const file = withEfMeta(meta, body);
    await snapshotToHistory(ctx.rt.brandRoot, rel, file);
    await writeFileAtomic(abs, file);

    ctx.state.setEntry('component', {
        path: rel,
        id: c.id,
        type: 'component',
        revisionId: c.revision_id ?? null,
        updatedAt: c.updated_at ?? null,
        serverUpdatedAt: c.updated_at ?? null,
        contentHash: sha256(Buffer.from(body, 'utf8')),
    });
    return { rel, absPath: abs, created: !existed };
}

export async function pullAllComponents(ctx: SyncContext, opts: { adopt?: boolean; force?: boolean } = {}): Promise<Array<{ rel: string; skipped?: boolean }>> {
    const list = await ctx.api.listComponents(ctx.rt.config.brandId);
    return await pullEach(ctx, 'component', list, async (c) => {
        if (opts.adopt) { const hit = await alreadyOnDisk(ctx, 'component', c.id); if (hit) return { rel: hit.rel, skipped: true }; }
        const r = await pullComponent(ctx, c.id, { force: opts.force });
        return { rel: r.rel, skipped: !!r.skipped };
    });
}

// ── Scripts ──────────────────────────────────────────────────────────

export async function pullScript(ctx: SyncContext, idOrCode: number | string, opts: { force?: boolean } = {}): Promise<{ rel: string; absPath: string; created: boolean; skipped?: string }> {
    const s = await ctx.api.getBackendScript(ctx.rt.config.brandId, idOrCode);
    const rel = relPathForScript(s);
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);
    const metaLine = serializeScriptEfMeta({
        v: 1, type: 'script', brandId: ctx.rt.config.brandId, id: s.id,
        slug: s.code ?? undefined, path: rel,
    }) + '\n';
    const body = s.content ?? '';
    if (await wouldClobberLocalEdits(ctx, 'script', rel, body, opts.force)) {
        log.warn(`Kept local ${rel} — it has changes not on the server. Push them ("ef push ${rel}"), or re-pull with --force to overwrite (a copy is saved to .ef-history).`);
        return { rel, absPath: abs, created: false, skipped: 'local-drift' };
    }
    const file = metaLine + body;
    const existed = await fileExists(abs);
    await snapshotToHistory(ctx.rt.brandRoot, rel, file);
    await writeFileAtomic(abs, file);

    ctx.state.setEntry('script', {
        path: rel,
        id: s.id,
        type: 'script',
        revisionId: s.revision_id ?? null,
        updatedAt: s.updated_at ?? null,
        serverUpdatedAt: s.updated_at ?? null,
        contentHash: sha256(Buffer.from(body, 'utf8')),
    });
    return { rel, absPath: abs, created: !existed };
}

export async function pullAllScripts(ctx: SyncContext, opts: { adopt?: boolean; force?: boolean } = {}): Promise<Array<{ rel: string; skipped?: boolean }>> {
    const list = await ctx.api.listBackendScripts(ctx.rt.config.brandId);
    return await pullEach(ctx, 'script', list, async (s) => {
        if (opts.adopt) { const hit = await alreadyOnDisk(ctx, 'script', s.id); if (hit) return { rel: hit.rel, skipped: true }; }
        const r = await pullScript(ctx, s.id, { force: opts.force });
        return { rel: r.rel, skipped: !!r.skipped };
    });
}

// ── Assets ───────────────────────────────────────────────────────────

export async function pullAsset(ctx: SyncContext, assetId: number): Promise<{ rel: string; absPath: string; created: boolean; skipped?: string } | null> {
    const payload = await ctx.api.getAssetContent(ctx.rt.config.brandId, assetId);
    const filePath = payload.file_path ?? payload.file_name;
    if (!filePath) return null;
    const rel = relPathForAsset({
        id: assetId,
        file_path: filePath,
        file_name: payload.file_name ?? filePath.split('/').pop() ?? `${assetId}`,
    });
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);

    if (needsLocalAssetFallback(payload)) {
        // Server gave us a stub line, not the actual bytes. Skip — keep whatever
        // is on disk (if anything) and let the user upload locally if they care.
        return { rel, absPath: abs, created: false, skipped: 'server returned a placeholder, not the file bytes' };
    }
    const buf = assetEditorPayloadToBuffer(payload);
    const existed = await fileExists(abs);
    await writeFileAtomic(abs, buf);

    ctx.state.setEntry('asset', {
        path: rel,
        id: assetId,
        type: 'asset',
        updatedAt: payload.updated_at ?? null,
        serverUpdatedAt: payload.updated_at ?? null,
        contentHash: sha256(buf),
    });
    return { rel, absPath: abs, created: !existed };
}

export async function pullAllAssets(ctx: SyncContext, opts: { adopt?: boolean } = {}): Promise<Array<{ rel: string; skipped?: boolean }>> {
    const assets = await ctx.api.listAssets(ctx.rt.config.brandId);
    return await pullEach(ctx, 'asset', assets, async (a) => {
        if (opts.adopt) { const hit = await alreadyOnDisk(ctx, 'asset', a.id); if (hit) return { rel: hit.rel, skipped: true }; }
        const r = await pullAsset(ctx, a.id);
        return r ? { rel: r.rel } : null;
    });
}

// ── Variables ────────────────────────────────────────────────────────

export async function pullVariables(ctx: SyncContext): Promise<{ rel: string; absPath: string }> {
    const vars = await ctx.api.getBrandVariables(ctx.rt.config.brandId);
    const rel = 'variables.json';
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);
    await writeFileAtomic(abs, JSON.stringify(vars, null, 2) + '\n');
    return { rel, absPath: abs };
}

// ── Push helpers ─────────────────────────────────────────────────────

export interface PushResult {
    rel: string;
    kind: 'page' | 'component' | 'script' | 'asset';
    action: 'created' | 'updated' | 'noop';
    serverId: number;
    revisionId?: number | null;
    previewUrl?: string | null;
    note?: string | null;
    /** Sanitized JSON body from the last API call (for `ef push --verbose`). */
    apiResponse?: Record<string, unknown>;
}

/**
 * Fetch the server's canonical stored body for a page/component after a push.
 *
 * The server rewrites content on save — it assigns `<inline-split-test>` ids,
 * reindents, auto-creates collections — so the bytes it stores differ from
 * what we sent. If we keep the *sent* bytes as the local file + baseline, the
 * next `ef diff`/push reports a phantom change for the server's own rewrite.
 * Adopting the server's version keeps local === server. Returns null on any
 * error so the caller falls back to the pushed body.
 */
async function fetchCanonicalBody(
    ctx: SyncContext,
    type: 'page' | 'component',
    id: number,
): Promise<{ body: string; revisionId: number | null; updatedAt: string | null } | null> {
    try {
        if (type === 'page') {
            const p = await ctx.api.getPageContent(ctx.rt.config.brandId, id);
            return { body: p.html ?? '', revisionId: p.revision_id ?? null, updatedAt: p.updated_at ?? null };
        }
        const c = await ctx.api.getComponentContent(ctx.rt.config.brandId, id);
        return { body: c.html ?? c.code ?? '', revisionId: c.revision_id ?? null, updatedAt: c.updated_at ?? null };
    } catch {
        return null;
    }
}

/**
 * A file is a *copy* of another entity when its embedded efmeta was issued for a
 * different path AND that original file still exists on disk. Pushing it under
 * the embedded id would trample the original's server entity, so the caller
 * creates a NEW entity instead. (A pure rename — the original path is gone —
 * keeps the id and just re-homes the path.)
 */
async function isCopyOfExistingFile(ctx: SyncContext, meta: EfMeta | null, rel: string): Promise<boolean> {
    if (!meta?.path || meta.path === rel) return false;
    try {
        return await fileExists(safeJoinBrandRoot(ctx.rt.brandRoot, meta.path));
    } catch {
        return false;
    }
}

/**
 * Guard against a tampered / merge-corrupted efmeta line. If this path is
 * tracked in `.ef-state.json`, the file's efmeta must still claim the SAME id and
 * type. If it doesn't (an editor, an AI, or a git merge changed or removed the
 * first line), refuse the push instead of writing to the wrong server entity — a
 * detected copy is exempt (it becomes a new entity anyway).
 */
function assertEfmetaMatchesState(ctx: SyncContext, kind: 'page' | 'component' | 'script', rel: string, meta: EfMeta | null, isCopy: boolean): void {
    if (isCopy) return;
    const tracked = ctx.state.getByPath(kind, rel);
    if (!tracked) return; // untracked path (new file / fresh clone) — nothing to compare
    const idOk = meta?.id === tracked.id;
    const typeOk = !meta || !meta.type || meta.type === kind;
    if (idOk && typeOk) return;
    const claim = meta?.id ? `the file's efmeta says #${meta.id}` : 'the file has no valid efmeta line';
    throw new CliError(
        ExitCode.Conflict,
        `Refusing to push ${rel}: its efmeta no longer matches the tracked identity ` +
        `(tracked as ${kind} #${tracked.id}, but ${claim}). The first line was changed — ` +
        `by an edit, an AI, or a git merge. Run "ef pull ${rel}" to restore the correct efmeta, then re-apply your body changes.`,
    );
}

/** How many historical snapshots to keep per file. */
const HISTORY_KEEP = 20;

/**
 * Local version history for people who don't use git. Before a sync overwrites a
 * file with *different* content, copy the CURRENT on-disk version into
 * `.ef-history/<rel>/<timestamp><ext>`. Best-effort — never blocks or fails a
 * sync. `.ef-history/` is a dotdir so the sync walkers skip it, and it's
 * gitignored on init.
 */
async function snapshotToHistory(brandRoot: string, rel: string, nextContent: string): Promise<void> {
    try {
        const abs = safeJoinBrandRoot(brandRoot, rel);
        if (!(await fileExists(abs))) return;
        const prev = await fs.promises.readFile(abs, 'utf8');
        if (prev === nextContent) return; // unchanged — nothing worth keeping
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dir = path.join(brandRoot, '.ef-history', rel);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, `${stamp}${path.extname(rel) || '.txt'}`), prev);
        // Retention: keep the newest HISTORY_KEEP (timestamps sort lexically).
        const entries = (await fs.promises.readdir(dir)).sort();
        for (const old of entries.slice(0, Math.max(0, entries.length - HISTORY_KEEP))) {
            await fs.promises.unlink(path.join(dir, old)).catch(() => { /* tolerated */ });
        }
    } catch { /* history is best-effort — never block a sync */ }
}

export async function pushPageFile(
    ctx: SyncContext,
    abs: string,
    rel: string,
    opts: { force?: boolean; draft?: boolean; verbose?: boolean } = {},
): Promise<PushResult> {
    const text = await fs.promises.readFile(abs, 'utf8');
    const { meta, body } = parseEfMeta(text);
    // Copy-trample guard: a duplicated file keeps the source's efmeta id; pushing
    // it would overwrite the original on the server. Detect it and create a new
    // page instead.
    const isCopy = await isCopyOfExistingFile(ctx, meta, rel);
    assertEfmetaMatchesState(ctx, 'page', rel, meta, isCopy);

    if (opts.verbose) {
        verboseLogOutgoingBody(rel, body, 'POST …/pages/{id}/editor `html`');
    }
    if (meta && meta.type === 'page' && meta.id && !isCopy) {
        const isDraft = opts.draft ?? ctx.rt.config.saveMode === 'draft';
        const trackedRev = ctx.state.getByPath('page', rel)?.revisionId ?? null;
        const expectedRev = opts.force ? null : (meta.revisionId ?? trackedRev);
        // Match vscode-extension: only send revision_id when saving a draft row.
        // Direct/publish saves apply to the live BrandPage row and clear revisions;
        // sending a stale draft revision_id can confuse some code paths. The
        // revision now lives in state, not efmeta, so fall back to it.
        const res = await ctx.api.updatePageHtml(ctx.rt.config.brandId, meta.id, body, {
            draft: isDraft,
            revisionId: isDraft ? (meta.revisionId ?? trackedRev) : null,
            expectedRevisionId: expectedRev,
        });
        const newMeta: EfMeta = { ...meta, path: rel };
        // Adopt the server's canonical version (inline-split-test ids, reindent,
        // auto-created collections) so the next push doesn't see a phantom diff.
        const canonical = await fetchCanonicalBody(ctx, 'page', meta.id);
        const finalBody = canonical?.body ?? body;
        const canonRev = canonical?.revisionId ?? res.revision_id ?? meta.revisionId ?? null;
        if (isDraft) {
            newMeta.revisionId = canonRev ?? undefined;
        } else {
            delete newMeta.revisionId;
        }
        await writeFileAtomic(abs, withEfMeta(newMeta, finalBody));
        ctx.state.setEntry('page', {
            path: rel,
            id: meta.id,
            type: 'page',
            revisionId: isDraft ? canonRev : null,
            updatedAt: new Date().toISOString(),
            serverUpdatedAt: canonical?.updatedAt ?? new Date().toISOString(),
            contentHash: sha256(Buffer.from(finalBody, 'utf8')),
        });
        return {
            rel,
            kind: 'page',
            action: 'updated',
            serverId: meta.id,
            revisionId: canonRev,
            previewUrl: res.preview_url ?? null,
            apiResponse: shrinkPushApiBody(res),
        };
    }

    // No meta or meta points elsewhere → create a new page from this file.
    // Slug is derived from the path under pages/ (matches extension behaviour).
    const slug = relPathForPageSlugFromRel(rel);
    if (!slug) {
        throw new Error(`Cannot derive page slug from "${rel}". Pages must live under pages/<slug>.ef.`);
    }
    const title = (slug.split('/').pop() || slug).replace(/-/g, ' ').replace(/^\w/, ch => ch.toUpperCase());
    const created = await ctx.api.createPage(ctx.rt.config.brandId, title, slug);
    // After create, push the body via /editor so it actually gets the user's content.
    const isDraftCreate = opts.draft ?? ctx.rt.config.saveMode === 'draft';
    const res = await ctx.api.updatePageHtml(ctx.rt.config.brandId, created.id, body, {
        draft: isDraftCreate,
    });
    const newMeta: EfMeta = {
        v: 1, type: 'page', brandId: ctx.rt.config.brandId, id: created.id,
        slug: created.slug ?? slug, name: created.title ?? title,
        path: rel,
    };
    if (isDraftCreate && res.revision_id != null) {
        newMeta.revisionId = res.revision_id;
    }
    await writeFileAtomic(abs, withEfMeta(newMeta, body));
    ctx.state.setEntry('page', {
        path: rel,
        id: created.id,
        type: 'page',
        revisionId: isDraftCreate ? (res.revision_id ?? null) : null,
        updatedAt: new Date().toISOString(),
        serverUpdatedAt: new Date().toISOString(),
        contentHash: sha256(Buffer.from(body, 'utf8')),
    });
    return {
        rel,
        kind: 'page',
        action: 'created',
        serverId: created.id,
        revisionId: res.revision_id ?? null,
        previewUrl: res.preview_url ?? null,
        note: isCopy && meta?.id
            ? `Copy of page #${meta.id} (efmeta issued for ${meta.path}); created NEW page #${created.id} (slug "${slug}") so the original is untouched.`
            : `Allocated new page id ${created.id} for slug "${slug}".`,
        apiResponse: {
            page: shrinkPushApiBody(created) ?? {},
            editor: shrinkPushApiBody(res) ?? {},
        },
    };
}

export async function pushComponentFile(
    ctx: SyncContext,
    abs: string,
    rel: string,
    opts: { force?: boolean; draft?: boolean; verbose?: boolean } = {},
): Promise<PushResult> {
    const text = await fs.promises.readFile(abs, 'utf8');
    const { meta, body } = parseEfMeta(text);
    // Copy-trample guard (see pushPageFile): a duplicated component file keeps the
    // source's efmeta id; create a new component instead of overwriting it.
    const isCopy = await isCopyOfExistingFile(ctx, meta, rel);
    assertEfmetaMatchesState(ctx, 'component', rel, meta, isCopy);

    if (opts.verbose) {
        verboseLogOutgoingBody(rel, body, 'POST …/components/{id}/editor `html`');
    }
    if (meta && meta.type === 'component' && meta.id && !isCopy) {
        const isDraft = opts.draft ?? ctx.rt.config.saveMode === 'draft';
        const trackedRev = ctx.state.getByPath('component', rel)?.revisionId ?? null;
        const expectedRev = opts.force ? null : (meta.revisionId ?? trackedRev);
        const res = await ctx.api.updateComponentHtml(ctx.rt.config.brandId, meta.id, body, {
            draft: isDraft,
            revisionId: isDraft ? (meta.revisionId ?? trackedRev) : null,
            expectedRevisionId: expectedRev,
        });
        const newMeta: EfMeta = { ...meta, path: rel };
        // Adopt the server's canonical version (same reasoning as pages).
        const canonical = await fetchCanonicalBody(ctx, 'component', meta.id);
        const finalBody = canonical?.body ?? body;
        const canonRev = canonical?.revisionId ?? res.revision_id ?? meta.revisionId ?? null;
        if (isDraft) {
            newMeta.revisionId = canonRev ?? undefined;
        } else {
            delete newMeta.revisionId;
        }
        await writeFileAtomic(abs, withEfMeta(newMeta, finalBody));
        ctx.state.setEntry('component', {
            path: rel,
            id: meta.id,
            type: 'component',
            revisionId: isDraft ? canonRev : null,
            updatedAt: new Date().toISOString(),
            serverUpdatedAt: canonical?.updatedAt ?? new Date().toISOString(),
            contentHash: sha256(Buffer.from(finalBody, 'utf8')),
        });
        return {
            rel,
            kind: 'component',
            action: 'updated',
            serverId: meta.id,
            revisionId: canonRev,
            apiResponse: shrinkPushApiBody(res),
        };
    }

    const code = relPathForComponentSlugFromRel(rel);
    if (!code) throw new Error(`Cannot derive component code from "${rel}". Components must live under components/<code>.ef.`);
    // Pass `code` as both name and code. Sending an empty code lets Laravel's
    // ConvertEmptyStringsToNull null it out and the server rejects it ("The code
    // must be a string"), so the create would 422.
    const created = await ctx.api.createComponent(ctx.rt.config.brandId, code, body, code);
    const newMeta: EfMeta = {
        v: 1, type: 'component', brandId: ctx.rt.config.brandId, id: created.id,
        slug: created.code ?? code, name: created.name ?? code,
        revisionId: created.revision_id ?? undefined, path: rel,
    };
    await writeFileAtomic(abs, withEfMeta(newMeta, body));
    ctx.state.setEntry('component', {
        path: rel,
        id: created.id,
        type: 'component',
        revisionId: created.revision_id ?? null,
        updatedAt: new Date().toISOString(),
        serverUpdatedAt: new Date().toISOString(),
        contentHash: sha256(Buffer.from(body, 'utf8')),
    });
    return {
        rel,
        kind: 'component',
        action: 'created',
        serverId: created.id,
        note: isCopy && meta?.id
            ? `Copy of component #${meta.id} (efmeta issued for ${meta.path}); created NEW component #${created.id} (code "${code}") so the original is untouched.`
            : `Allocated new component id ${created.id} (code "${code}").`,
        apiResponse: shrinkPushApiBody(created) ?? {},
    };
}

export async function pushScriptFile(
    ctx: SyncContext,
    abs: string,
    rel: string,
    opts: { force?: boolean; verbose?: boolean } = {},
): Promise<PushResult> {
    const text = await fs.promises.readFile(abs, 'utf8');
    const { meta, body } = parseScriptMeta(text);
    assertEfmetaMatchesState(ctx, 'script', rel, meta, false);
    if (opts.verbose) {
        verboseLogOutgoingBody(rel, body, 'PUT …/scripts/{id} body');
    }
    void opts.force; // accepted for symmetry; backend doesn't gate scripts on revision yet.

    const code = relPathForScriptCodeFromRel(rel);
    if (meta && meta.type === 'script' && meta.id) {
        const updated = await ctx.api.updateBackendScript(ctx.rt.config.brandId, meta.id, body);
        const newFirst = serializeScriptEfMeta({ ...meta, slug: updated.code ?? meta.slug, path: rel }) + '\n';
        await writeFileAtomic(abs, newFirst + body);
        ctx.state.setEntry('script', {
            path: rel,
            id: meta.id,
            type: 'script',
            revisionId: updated.revision_id ?? null,
            updatedAt: updated.updated_at ?? null,
            serverUpdatedAt: updated.updated_at ?? null,
            contentHash: sha256(Buffer.from(body, 'utf8')),
        });
        return {
            rel,
            kind: 'script',
            action: 'updated',
            serverId: meta.id,
            revisionId: updated.revision_id ?? null,
            apiResponse: shrinkPushApiBody(updated) ?? {},
        };
    }

    if (!code) throw new Error(`Cannot derive script code from "${rel}". Scripts must live under scripts/<code>.js.`);
    const created = await ctx.api.createBackendScript(ctx.rt.config.brandId, code, code, body);
    const newFirst = serializeScriptEfMeta({
        v: 1, type: 'script', brandId: ctx.rt.config.brandId, id: created.id,
        slug: created.code ?? code, path: rel,
    }) + '\n';
    await writeFileAtomic(abs, newFirst + body);
    ctx.state.setEntry('script', {
        path: rel,
        id: created.id,
        type: 'script',
        revisionId: created.revision_id ?? null,
        updatedAt: created.updated_at ?? null,
        serverUpdatedAt: created.updated_at ?? null,
        contentHash: sha256(Buffer.from(body, 'utf8')),
    });
    return {
        rel,
        kind: 'script',
        action: 'created',
        serverId: created.id,
        note: `Allocated new script id ${created.id} (code "${code}").`,
        apiResponse: shrinkPushApiBody(created) ?? {},
    };
}

export async function pushAssetFile(
    ctx: SyncContext,
    abs: string,
    rel: string,
): Promise<PushResult> {
    const bytes = await readFileBytes(abs);
    // server file_path strips the leading "assets/" we use for local layout.
    const remotePath = rel.replace(/^assets\//, '');
    const uploaded = await ctx.api.uploadAssetByPath(ctx.rt.config.brandId, remotePath, bytes);
    if (!uploaded) {
        return { rel, kind: 'asset', action: 'noop', serverId: 0, note: 'Server accepted the upload but did not return a file id.' };
    }
    ctx.state.setEntry('asset', {
        path: rel,
        id: uploaded.id,
        type: 'asset',
        updatedAt: new Date().toISOString(),
        serverUpdatedAt: new Date().toISOString(),
        contentHash: sha256(bytes),
    });
    return { rel, kind: 'asset', action: 'updated', serverId: uploaded.id, apiResponse: shrinkPushApiBody(uploaded) ?? {} };
}

// ── Internal slug helpers ────────────────────────────────────────────

export function relPathForPageSlugFromRel(rel: string): string | null {
    const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!r.startsWith('pages/') || !r.toLowerCase().endsWith('.ef')) return null;
    return r.slice('pages/'.length, r.length - '.ef'.length);
}

export function relPathForComponentSlugFromRel(rel: string): string | null {
    const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!r.startsWith('components/') || !r.toLowerCase().endsWith('.ef')) return null;
    return r.slice('components/'.length, r.length - '.ef'.length);
}

export function relPathForScriptCodeFromRel(rel: string): string | null {
    const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!r.startsWith('scripts/') || !r.toLowerCase().endsWith('.js')) return null;
    return r.slice('scripts/'.length, r.length - '.js'.length);
}

/** Derive (kind, brand-root-relative path) from an absolute file path within
 *  the brand root. Returns null if the file is outside the brand root. */
export function classifyAbsPath(brandRoot: string, abs: string): { kind: 'page' | 'component' | 'script' | 'asset'; rel: string } | null {
    const root = path.resolve(brandRoot);
    const a = path.resolve(abs);
    if (a !== root && !a.startsWith(root + path.sep)) return null;
    const rel = a.slice(root.length + 1).split(path.sep).join('/');
    if (rel.startsWith('pages/') && rel.toLowerCase().endsWith('.ef')) return { kind: 'page', rel };
    if (rel.startsWith('components/') && rel.toLowerCase().endsWith('.ef')) return { kind: 'component', rel };
    if (rel.startsWith('scripts/') && rel.toLowerCase().endsWith('.js')) return { kind: 'script', rel };
    if (rel.startsWith('assets/')) return { kind: 'asset', rel };
    return null;
}

/**
 * Parse a backend-script file's `// efmeta:{...}` header. Strips a UTF-8
 * BOM the same way `parseEfMeta` does so a Notepad-saved script doesn't
 * accidentally lose its identity (which would silently allocate a new
 * server-side script id on the next push).
 */
export function parseScriptMeta(text: string): { meta: EfMeta | null; body: string } {
    const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const firstLineEnd = normalized.indexOf('\n');
    if (firstLineEnd < 0) return { meta: null, body: normalized };
    const first = normalized.slice(0, firstLineEnd);
    if (!first.startsWith('// efmeta:')) return { meta: null, body: normalized };
    try {
        const meta = JSON.parse(first.slice('// efmeta:'.length)) as EfMeta;
        const body = normalized.slice(firstLineEnd + 1);
        return { meta, body };
    } catch {
        return { meta: null, body: normalized };
    }
}

/** Re-export so callers do not need to import `sync/efMeta` directly. */
export { serializeEfMeta };
