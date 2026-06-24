import * as fs from 'fs';
import * as path from 'path';
import { ApiClient } from '../api/client';
import { Component, Page } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { EfRuntime } from '../utils/store';
import { SyncStateFile, StateEntry } from '../sync/stateFile';
import { safeJoinBrandRoot } from '../sync/paths';
import { fileExists } from '../utils/fs';

/**
 * After a server-side delete, remove the local file and its `.ef-state.json`
 * entry so disk and drift detection stay consistent. Best-effort — never
 * throws — and returns whether a local file was actually removed.
 */
export async function removeLocalEntity(
    rt: EfRuntime,
    kind: StateEntry['type'],
    relPath: string,
): Promise<boolean> {
    let removed = false;
    try {
        const abs = safeJoinBrandRoot(rt.brandRoot, relPath);
        if (await fileExists(abs)) {
            await fs.promises.unlink(abs);
            removed = true;
        }
    } catch { /* tolerated — server delete already succeeded */ }
    try {
        const state = await SyncStateFile.load(rt.brandRoot, rt.config.brandId);
        if (!state.isVersionTooNew()) {
            state.deleteEntry(kind, relPath);
            await state.save();
        }
    } catch { /* tolerated */ }
    return removed;
}

/** Preview URL uses GET /editor revision_id when present — same as the VS Code extension. */
export async function fetchPagePreviewBundle(
    api: ApiClient,
    brandId: number,
    pageId: number,
): Promise<{ previewUrl: string; liveUrl: string | null; revisionId: number | null }> {
    const editor = await api.getPageContent(brandId, pageId);
    const revisionId = editor.revision_id ?? null;
    const previewUrl = await api.getPreviewUrl(brandId, pageId, revisionId);
    const liveUrl = await api.getLiveUrl(brandId, pageId).catch(() => null);
    return { previewUrl, liveUrl, revisionId };
}

/**
 * Resolve a page by its slug (or id, if numeric). Used by `ef get`,
 * `ef pages publish`, `ef pages preview`, etc. Slugs are not unique
 * across variants — the page list returns one row per active variant
 * and per draft variant — so we prefer an active match if there is one.
 */
export async function resolvePageBySlug(
    api: ApiClient,
    brandId: number,
    slugOrId: string,
): Promise<Page> {
    const id = parseInt(slugOrId, 10);
    if (Number.isFinite(id) && /^\d+$/.test(slugOrId)) {
        const p = await api.getPageContent(brandId, id);
        return p;
    }

    const all = await api.listPages(brandId);
    const matches = all.filter(p => p.slug === slugOrId || p.variant_slug === slugOrId);
    if (matches.length === 0) {
        throw new CliError(ExitCode.NotFound, `No page with slug "${slugOrId}".`);
    }
    if (matches.length === 1) return matches[0];
    const active = matches.find(m => m.is_active_version);
    if (active) return active;
    return matches.sort((a, b) => Date.parse(b.updated_at ?? '0') - Date.parse(a.updated_at ?? '0'))[0];
}

/**
 * Read a JSON object payload from a file (or stdin when the path is "-").
 * Used by command surfaces that take `--file` (products, page settings) so a
 * caller can supply a full payload that flags then override. Throws a usage
 * error on missing files or non-object / invalid JSON.
 */
export async function readJsonPayloadFile(filePath: string): Promise<Record<string, unknown>> {
    let raw: string;
    if (filePath === '-') {
        raw = await readStdin();
    } else {
        const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        if (!(await fileExists(abs))) throw new CliError(ExitCode.NotFound, `File not found: ${filePath}`);
        raw = await fs.promises.readFile(abs, 'utf8');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) {
        throw new CliError(ExitCode.Validation, `Invalid JSON in ${filePath}: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CliError(ExitCode.Validation, `Expected a JSON object in ${filePath}.`);
    }
    return parsed as Record<string, unknown>;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

export async function resolveComponentByCodeOrName(
    api: ApiClient,
    brandId: number,
    codeOrName: string,
): Promise<Component> {
    const id = parseInt(codeOrName, 10);
    if (Number.isFinite(id) && /^\d+$/.test(codeOrName)) {
        return await api.getComponentContent(brandId, id);
    }
    const all = await api.listComponents(brandId);
    const found = all.find(c => c.code === codeOrName || c.name === codeOrName);
    if (!found) throw new CliError(ExitCode.NotFound, `Component "${codeOrName}" not found.`);
    return await api.getComponentContent(brandId, found.id);
}
