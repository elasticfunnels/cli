import * as path from 'path';
import * as fs from 'fs';
import { fileExists, writeFileAtomic } from '../utils/fs';

/**
 * `.ef-state.json` — the on-disk index that ties local files to server
 * entities. Mirrors the file the VS Code extension writes (same path,
 * different schema; see `vscode-extension/src/sync/stateFile.ts`).
 *
 * Schema versions
 * ----------------
 * The CLI and the VS Code extension version `.ef-state.json` independently
 * because they ship on different cadences. To prevent an older client from
 * silently clobbering data a newer client added, both tools refuse to
 * **write** to a file whose `version` is greater than what they understand.
 * Reads always succeed so users can still inspect state.
 *
 * The CLI never deletes top-level fields it doesn't recognize; they're
 * stashed in `unknownTopLevel` and re-emitted verbatim on save so the
 * extension's bookkeeping survives a CLI roundtrip.
 */

export interface StateEntry {
    /** Brand-root-relative POSIX path (e.g. "pages/login.ef"). */
    path: string;
    /** Server entity id. Required. */
    id: number;
    /** ISO of the server's last seen `updated_at`. */
    updatedAt?: string | null;
    /** Latest revision id the local file matches. */
    revisionId?: number | null;
    /** SHA-256 of the body (without efmeta). Used for drift detection. */
    contentHash?: string | null;
    /** Original ISO from the server when contentHash was captured. */
    serverUpdatedAt?: string | null;
    /** What kind of entity this entry tracks. */
    type: 'page' | 'component' | 'templatePage' | 'script' | 'asset';
    /** Free-form extension-only metadata we should preserve. */
    extra?: Record<string, unknown>;
}

export interface StateFileShape {
    version: 1;
    brandId: number;
    /** Last successful pages sync-delta cutoff (ISO). */
    lastPagesSyncAt?: string | null;
    /** Last successful assets sync-delta cutoff (ISO). */
    lastAssetsSyncAt?: string | null;
    pages: Record<string, StateEntry>;        // keyed by path (brand-root-relative)
    components: Record<string, StateEntry>;
    templatePages: Record<string, StateEntry>;
    scripts: Record<string, StateEntry>;
    assets: Record<string, StateEntry>;
}

/**
 * Bump only when the on-disk format changes in a way an older CLI can't
 * safely write back. The runtime uses this as a forward-compat guard:
 * if a future build writes a higher version, this client refuses to
 * write so it can't strip fields the user's other tooling needs.
 */
export const STATE_VERSION = 1;
const MAX_WRITABLE_STATE_VERSION = 2;

type ExtensionMirrorConfig = {
    entriesKey: 'pagesById' | 'componentsById' | 'templatePagesById' | 'scriptsById' | 'assetsById';
    pathKey: 'pathToPageId' | 'pathToComponentId' | 'pathToTemplatePageId' | 'pathToScriptId' | 'pathToAssetId';
    includeRevision: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' || value === null ? value : null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The VS Code extension keeps id-keyed buckets (`pagesById`, …) plus path
 * indexes; the CLI keeps path-keyed buckets (`pages`, …). When a file was last
 * written by the extension our v1 buckets may be absent — these let us rebuild
 * our entries from the extension's buckets so a CLI run doesn't lose its sync
 * baseline. Symmetric to `mirrorExtensionEntry`, which keeps the extension's
 * buckets current when the CLI writes.
 */
const EXTENSION_MIRROR_BUCKETS: ReadonlyArray<{ type: StateEntry['type']; entriesKey: string }> = [
    { type: 'page', entriesKey: 'pagesById' },
    { type: 'component', entriesKey: 'componentsById' },
    { type: 'templatePage', entriesKey: 'templatePagesById' },
    { type: 'script', entriesKey: 'scriptsById' },
    { type: 'asset', entriesKey: 'assetsById' },
];

function bucketForShape(data: StateFileShape, kind: StateEntry['type']): Record<string, StateEntry> {
    switch (kind) {
        case 'page': return data.pages;
        case 'component': return data.components;
        case 'templatePage': return data.templatePages;
        case 'script': return data.scripts;
        case 'asset': return data.assets;
    }
}

/**
 * Fill gaps in our path-keyed buckets from the extension's id-keyed buckets.
 * Existing v1 entries always win — we only add ids/paths v1 doesn't already
 * track — so a CLI-written baseline is never overwritten by a stale mirror.
 */
function hydrateFromExtensionBuckets(parsed: Record<string, unknown>, data: StateFileShape): void {
    for (const { type, entriesKey } of EXTENSION_MIRROR_BUCKETS) {
        const entries = parsed[entriesKey];
        if (!isRecord(entries)) continue;
        const target = bucketForShape(data, type);
        const knownIds = new Set<number>();
        for (const e of Object.values(target)) knownIds.add(e.id);
        for (const [idKey, value] of Object.entries(entries)) {
            if (!isRecord(value) || typeof value.path !== 'string') continue;
            const id = Number(idKey);
            if (!Number.isFinite(id) || id <= 0) continue;
            if (knownIds.has(id) || target[value.path]) continue;
            const serverUpdatedAt = stringOrNull(value.serverUpdatedAt);
            target[value.path] = {
                path: value.path,
                id,
                updatedAt: serverUpdatedAt ?? stringOrNull(value.updatedAt),
                revisionId: type === 'asset' ? null : numberOrNull(value.revisionId),
                contentHash: stringOrNull(value.contentHash),
                serverUpdatedAt,
                type,
            };
        }
    }
}

export class SyncStateFile {
    private data: StateFileShape;
    /** Top-level fields we didn't recognize; preserved verbatim on save. */
    private unknownTopLevel: Record<string, unknown> = {};
    /** The version actually present on disk, possibly higher than STATE_VERSION. */
    private loadedVersion: number = STATE_VERSION;

    /** Schema version this build of the CLI will write. Mirrors the const above. */
    static readonly STATE_VERSION = STATE_VERSION;

    constructor(public readonly statePath: string, data?: StateFileShape) {
        this.data = data ?? {
            version: 1,
            brandId: 0,
            lastPagesSyncAt: null,
            lastAssetsSyncAt: null,
            pages: {},
            components: {},
            templatePages: {},
            scripts: {},
            assets: {},
        };
    }

    static async load(stateDir: string, brandId: number): Promise<SyncStateFile> {
        const p = path.join(stateDir, '.ef-state.json');
        const bakPath = `${p}.bak`;
        const tryRead = async (target: string): Promise<{ data: StateFileShape; loadedVersion: number; unknown: Record<string, unknown> } | null> => {
            if (!(await fileExists(target))) return null;
            let raw: string;
            try { raw = await fs.promises.readFile(target, 'utf8'); } catch { return null; }
            if (!raw.trim()) return null;
            let parsed: Partial<StateFileShape> & Record<string, unknown> = {};
            try { parsed = JSON.parse(raw) as Partial<StateFileShape> & Record<string, unknown>; } catch { return null; }
            const knownKeys = new Set([
                'version', 'brandId', 'lastPagesSyncAt', 'lastAssetsSyncAt',
                'pages', 'components', 'templatePages', 'scripts', 'assets',
            ]);
            const unknown: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (!knownKeys.has(k)) unknown[k] = v;
            }
            const loadedVersion = typeof parsed.version === 'number' ? parsed.version : STATE_VERSION;
            const data: StateFileShape = {
                version: 1,
                brandId: typeof parsed.brandId === 'number' ? parsed.brandId : brandId,
                lastPagesSyncAt: parsed.lastPagesSyncAt ?? null,
                lastAssetsSyncAt: parsed.lastAssetsSyncAt ?? null,
                pages: (parsed.pages as Record<string, StateEntry>) ?? {},
                components: (parsed.components as Record<string, StateEntry>) ?? {},
                templatePages: (parsed.templatePages as Record<string, StateEntry>) ?? {},
                scripts: (parsed.scripts as Record<string, StateEntry>) ?? {},
                assets: (parsed.assets as Record<string, StateEntry>) ?? {},
            };
            // Recover our baseline from the extension's id-keyed buckets when our
            // own path-keyed buckets are missing (file last written by the
            // extension). v1 entries win; this only fills gaps.
            hydrateFromExtensionBuckets(parsed, data);
            return { data, loadedVersion, unknown };
        };

        const primary = await tryRead(p);
        if (primary) {
            const sf = new SyncStateFile(p, primary.data);
            sf.loadedVersion = primary.loadedVersion;
            sf.unknownTopLevel = primary.unknown;
            return sf;
        }
        // Primary missing or corrupt — try the .bak we wrote on the last successful save.
        const fromBackup = await tryRead(bakPath);
        if (fromBackup) {
            const sf = new SyncStateFile(p, fromBackup.data);
            sf.loadedVersion = fromBackup.loadedVersion;
            sf.unknownTopLevel = fromBackup.unknown;
            // Promote the backup back to the primary slot so future loads are fast.
            try { await writeFileAtomic(p, JSON.stringify(fromBackup.data, null, 2) + '\n'); } catch { /* tolerated */ }
            return sf;
        }
        return new SyncStateFile(p, {
            version: 1,
            brandId,
            lastPagesSyncAt: null,
            lastAssetsSyncAt: null,
            pages: {}, components: {}, templatePages: {}, scripts: {}, assets: {},
        });
    }

    get brandId(): number { return this.data.brandId; }

    setBrandId(id: number): void { this.data.brandId = id; }

    get lastPagesSyncAt(): string | null { return this.data.lastPagesSyncAt ?? null; }
    setLastPagesSyncAt(iso: string | null): void { this.data.lastPagesSyncAt = iso; }
    get lastAssetsSyncAt(): string | null { return this.data.lastAssetsSyncAt ?? null; }
    setLastAssetsSyncAt(iso: string | null): void { this.data.lastAssetsSyncAt = iso; }

    /**
     * `true` when the loaded state file was produced by a CLI build with
     * a higher schema number than this one understands. Callers should
     * avoid mutating sync state in this case.
     */
    isVersionTooNew(): boolean { return this.loadedVersion > MAX_WRITABLE_STATE_VERSION; }
    getLoadedVersion(): number { return this.loadedVersion; }

    pages(): Record<string, StateEntry> { return this.data.pages; }
    components(): Record<string, StateEntry> { return this.data.components; }
    templatePages(): Record<string, StateEntry> { return this.data.templatePages; }
    scripts(): Record<string, StateEntry> { return this.data.scripts; }
    assets(): Record<string, StateEntry> { return this.data.assets; }

    setEntry(kind: StateEntry['type'], entry: StateEntry): void {
        const bucket = this.bucketFor(kind);
        bucket[entry.path] = entry;
        this.mirrorExtensionEntry(kind, entry);
    }

    deleteEntry(kind: StateEntry['type'], pathKey: string): void {
        const bucket = this.bucketFor(kind);
        const removed = bucket[pathKey];
        delete bucket[pathKey];
        this.deleteExtensionMirrorEntry(kind, pathKey, removed);
    }

    getByPath(kind: StateEntry['type'], pathKey: string): StateEntry | undefined {
        return this.bucketFor(kind)[pathKey];
    }

    getById(kind: StateEntry['type'], id: number): StateEntry | undefined {
        for (const e of Object.values(this.bucketFor(kind))) {
            if (e.id === id) return e;
        }
        return undefined;
    }

    private bucketFor(kind: StateEntry['type']): Record<string, StateEntry> {
        switch (kind) {
            case 'page': return this.data.pages;
            case 'component': return this.data.components;
            case 'templatePage': return this.data.templatePages;
            case 'script': return this.data.scripts;
            case 'asset': return this.data.assets;
        }
    }

    private extensionMirrorFor(kind: StateEntry['type']): ExtensionMirrorConfig {
        switch (kind) {
            case 'page':
                return { entriesKey: 'pagesById', pathKey: 'pathToPageId', includeRevision: true };
            case 'component':
                return { entriesKey: 'componentsById', pathKey: 'pathToComponentId', includeRevision: true };
            case 'templatePage':
                return { entriesKey: 'templatePagesById', pathKey: 'pathToTemplatePageId', includeRevision: true };
            case 'script':
                return { entriesKey: 'scriptsById', pathKey: 'pathToScriptId', includeRevision: true };
            case 'asset':
                return { entriesKey: 'assetsById', pathKey: 'pathToAssetId', includeRevision: false };
        }
    }

    private mutableUnknownRecord(key: string): Record<string, unknown> {
        const existing = this.unknownTopLevel[key];
        if (isRecord(existing)) return existing;
        const created: Record<string, unknown> = {};
        this.unknownTopLevel[key] = created;
        return created;
    }

    private readonlyUnknownRecord(key: string): Record<string, unknown> | null {
        const existing = this.unknownTopLevel[key];
        return isRecord(existing) ? existing : null;
    }

    private deletePathClaimsForId(pathMap: Record<string, unknown>, id: number): void {
        for (const [relPath, mappedId] of Object.entries(pathMap)) {
            if (mappedId === id) delete pathMap[relPath];
        }
    }

    /**
     * Keep the VS Code extension's v2 buckets current when the CLI writes its
     * path-keyed v1 buckets. Otherwise a CLI pull/push can leave the extension
     * with a stale baseline and its next save opens a false conflict dialog.
     */
    private mirrorExtensionEntry(kind: StateEntry['type'], entry: StateEntry): void {
        const config = this.extensionMirrorFor(kind);
        const entries = this.mutableUnknownRecord(config.entriesKey);
        const pathMap = this.mutableUnknownRecord(config.pathKey);
        const key = String(entry.id);
        const previous = isRecord(entries[key]) ? entries[key] : {};
        this.deletePathClaimsForId(pathMap, entry.id);

        const updatedAt = entry.updatedAt
            ?? entry.serverUpdatedAt
            ?? (typeof previous.updatedAt === 'string' ? previous.updatedAt : new Date().toISOString());

        const mirrored: Record<string, unknown> = {
            ...previous,
            path: entry.path,
            updatedAt,
            contentHash: entry.contentHash ?? stringOrNull(previous.contentHash),
            serverUpdatedAt: entry.serverUpdatedAt ?? stringOrNull(previous.serverUpdatedAt),
        };

        if (config.includeRevision) {
            mirrored.revisionId = entry.revisionId ?? (typeof previous.revisionId === 'number' ? previous.revisionId : null);
        }
        if (kind === 'page') {
            mirrored.domain = stringOrNull(previous.domain);
            mirrored.previewUrl = stringOrNull(previous.previewUrl);
        }

        entries[key] = mirrored;
        pathMap[entry.path] = entry.id;
    }

    private deleteExtensionMirrorEntry(kind: StateEntry['type'], pathKey: string, removed?: StateEntry): void {
        const config = this.extensionMirrorFor(kind);
        const entries = this.readonlyUnknownRecord(config.entriesKey);
        const pathMap = this.readonlyUnknownRecord(config.pathKey);
        if (!entries || !pathMap) return;

        const mappedId = pathMap[pathKey];
        delete pathMap[pathKey];

        const id = removed?.id ?? (typeof mappedId === 'number' ? mappedId : null);
        if (id != null) {
            delete entries[String(id)];
            this.deletePathClaimsForId(pathMap, id);
        }
    }

    async save(): Promise<void> {
        if (this.loadedVersion > MAX_WRITABLE_STATE_VERSION) {
            // Defensive no-op: don't overwrite a file produced by a newer
            // client. The user gets a warning at the start of the run; we
            // silently skip the write so the API operations they just ran
            // still complete cleanly. Re-pull after upgrading to refresh
            // the local state.
            return;
        }
        // Write `unknownTopLevel` first so our well-known keys win on JSON merge
        // (an older field with the same name as ours would otherwise survive).
        const merged = {
            ...this.unknownTopLevel,
            ...this.data,
            version: Math.max(STATE_VERSION, this.loadedVersion),
        };
        const out = JSON.stringify(merged, null, 2) + '\n';

        // Best-effort backup so a power loss / crash mid-rename leaves us with
        // at least one valid copy. Mirrors the extension's behaviour.
        const bakPath = `${this.statePath}.bak`;
        try {
            if (await fileExists(this.statePath)) {
                const current = await fs.promises.readFile(this.statePath);
                if (current.byteLength > 2) {
                    await fs.promises.writeFile(bakPath, current);
                }
            }
        } catch { /* tolerated; we still have the in-memory cache */ }

        await writeFileAtomic(this.statePath, out);
    }
}
