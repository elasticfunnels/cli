import * as path from 'path';
import * as fs from 'fs';
import { ApiClient } from '../api/client';
import { EfRuntime } from '../utils/store';
import { SyncStateFile } from '../sync/stateFile';
import { EfMeta, parseEfMeta, serializeEfMeta, withEfMeta } from '../sync/efMeta';
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
    pull: (item: T) => Promise<{ rel: string } | null>,
): Promise<Array<{ rel: string }>> {
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
    return out.filter((r): r is { rel: string } => r != null).map((r) => ({ rel: r.rel }));
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

export async function pullPage(ctx: SyncContext, pageId: number): Promise<{ rel: string; absPath: string; created: boolean }> {
    const page = await ctx.api.getPageContent(ctx.rt.config.brandId, pageId);
    const rel = relPathForPage(page);
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
    const file = withEfMeta(meta, body);
    const existed = await fileExists(abs);
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

export async function pullAllPages(ctx: SyncContext): Promise<Array<{ rel: string }>> {
    const pages = await ctx.api.listPages(ctx.rt.config.brandId);
    return await pullEach(ctx, 'page', pages, async (p) => {
        const { rel } = await pullPage(ctx, p.id);
        return { rel };
    });
}

// ── Components ───────────────────────────────────────────────────────

export async function pullComponent(ctx: SyncContext, componentId: number): Promise<{ rel: string; absPath: string; created: boolean }> {
    const c = await ctx.api.getComponentContent(ctx.rt.config.brandId, componentId);
    const rel = relPathForComponent(c);
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
    const existed = await fileExists(abs);
    await writeFileAtomic(abs, withEfMeta(meta, body));

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

export async function pullAllComponents(ctx: SyncContext): Promise<Array<{ rel: string }>> {
    const list = await ctx.api.listComponents(ctx.rt.config.brandId);
    return await pullEach(ctx, 'component', list, async (c) => {
        const { rel } = await pullComponent(ctx, c.id);
        return { rel };
    });
}

// ── Scripts ──────────────────────────────────────────────────────────

export async function pullScript(ctx: SyncContext, idOrCode: number | string): Promise<{ rel: string; absPath: string; created: boolean }> {
    const s = await ctx.api.getBackendScript(ctx.rt.config.brandId, idOrCode);
    const rel = relPathForScript(s);
    const abs = safeJoinBrandRoot(ctx.rt.brandRoot, rel);
    const metaLine = `// efmeta:${JSON.stringify({
        v: 1,
        type: 'script',
        brandId: ctx.rt.config.brandId,
        id: s.id,
        slug: s.code,
        name: s.name,
        revisionId: s.revision_id ?? undefined,
        remoteUpdatedAt: s.updated_at ?? undefined,
        path: rel,
    } satisfies EfMeta)}\n`;
    const body = s.content ?? '';
    const existed = await fileExists(abs);
    await writeFileAtomic(abs, metaLine + body);

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

export async function pullAllScripts(ctx: SyncContext): Promise<Array<{ rel: string }>> {
    const list = await ctx.api.listBackendScripts(ctx.rt.config.brandId);
    return await pullEach(ctx, 'script', list, async (s) => {
        const { rel } = await pullScript(ctx, s.id);
        return { rel };
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

export async function pullAllAssets(ctx: SyncContext): Promise<Array<{ rel: string }>> {
    const assets = await ctx.api.listAssets(ctx.rt.config.brandId);
    return await pullEach(ctx, 'asset', assets, async (a) => await pullAsset(ctx, a.id));
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

export async function pushPageFile(
    ctx: SyncContext,
    abs: string,
    rel: string,
    opts: { force?: boolean; draft?: boolean; verbose?: boolean } = {},
): Promise<PushResult> {
    const text = await fs.promises.readFile(abs, 'utf8');
    const { meta, body } = parseEfMeta(text);

    if (opts.verbose) {
        verboseLogOutgoingBody(rel, body, 'POST …/pages/{id}/editor `html`');
    }
    if (meta && meta.type === 'page' && meta.id) {
        const isDraft = opts.draft ?? ctx.rt.config.saveMode === 'draft';
        const expectedRev = opts.force ? null : (meta.revisionId ?? ctx.state.getByPath('page', rel)?.revisionId ?? null);
        // Match vscode-extension: only send revision_id when saving a draft row.
        // Direct/publish saves apply to the live BrandPage row and clear revisions;
        // sending a stale draft revision_id can confuse some code paths.
        const res = await ctx.api.updatePageHtml(ctx.rt.config.brandId, meta.id, body, {
            draft: isDraft,
            revisionId: isDraft ? (meta.revisionId ?? null) : null,
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
        note: `Allocated new page id ${created.id} for slug "${slug}".`,
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

    if (opts.verbose) {
        verboseLogOutgoingBody(rel, body, 'POST …/components/{id}/editor `html`');
    }
    if (meta && meta.type === 'component' && meta.id) {
        const isDraft = opts.draft ?? ctx.rt.config.saveMode === 'draft';
        const expectedRev = opts.force ? null : (meta.revisionId ?? ctx.state.getByPath('component', rel)?.revisionId ?? null);
        const res = await ctx.api.updateComponentHtml(ctx.rt.config.brandId, meta.id, body, {
            draft: isDraft,
            revisionId: isDraft ? (meta.revisionId ?? null) : null,
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
        note: `Allocated new component id ${created.id} (code "${code}").`,
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
    if (opts.verbose) {
        verboseLogOutgoingBody(rel, body, 'PUT …/scripts/{id} body');
    }
    void opts.force; // accepted for symmetry; backend doesn't gate scripts on revision yet.

    const code = relPathForScriptCodeFromRel(rel);
    if (meta && meta.type === 'script' && meta.id) {
        const updated = await ctx.api.updateBackendScript(ctx.rt.config.brandId, meta.id, body);
        const newFirst = `// efmeta:${JSON.stringify({
            ...meta,
            slug: updated.code,
            name: updated.name,
            revisionId: updated.revision_id ?? meta.revisionId,
            remoteUpdatedAt: updated.updated_at ?? meta.remoteUpdatedAt,
            path: rel,
        } satisfies EfMeta)}\n`;
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
    const newFirst = `// efmeta:${JSON.stringify({
        v: 1, type: 'script', brandId: ctx.rt.config.brandId, id: created.id,
        slug: created.code, name: created.name, revisionId: created.revision_id ?? undefined, path: rel,
    } satisfies EfMeta)}\n`;
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
