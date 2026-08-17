import { makeRuntime, EfAuth } from '../utils/store';
import {
    SyncContext,
    buildSyncContext,
    pullAllPages,
    pullAllComponents,
    pullAllScripts,
    pullVariables,
    pullAllAssets,
    pushPageFile,
    pushComponentFile,
    pushScriptFile,
    classifyAbsPath,
    PushResult,
} from '../sync/sync';
import { safeJoinBrandRoot } from '../sync/paths';

/**
 * High-level helpers that let a program drive this CLI **as a library** —
 * materialize a brand into a temp directory, push edits back, pull assets on
 * demand — without shelling out and without writing credentials to disk.
 *
 * The distinction from the `ef` commands is deliberate: those assume a human in
 * a checkout with `.ef/config.json` and `.ef/auth`. An automated caller has
 * neither, and giving it one would mean persisting a brand-scoped token into a
 * throwaway workspace.
 */

export interface BrandCredentials {
    apiUrl: string;
    /**
     * The API credential: a brand-scoped agent token when
     * `auth.scheme === 'bearer'`, or an EF-Access-Key otherwise.
     */
    apiKey: string;
    brandId: number;
    /** Omitted → EF-Access-Key. `{ scheme: 'bearer' }` for an agent token. */
    auth?: EfAuth;
}

export interface WorkspaceOptions {
    /** Include assets in a materialize. Default `false` — pull them on demand instead. */
    assets?: boolean;
    /** Save mode for pushes. Default `'draft'`, so a library caller never publishes by accident. */
    saveMode?: 'draft' | 'direct';
    /** Disk layout. Default `'flat'` (path = slug). */
    syncLayout?: 'flat' | 'nested';
}

/**
 * Build a {@link SyncContext} bound to `dir` from in-memory credentials, with no
 * `.ef/` folder written. Only `.ef-state.json` lands in `dir` — it carries no
 * secret, and push/diff optimistic concurrency needs it.
 */
export async function openBrandWorkspace(
    dir: string,
    creds: BrandCredentials,
    opts: WorkspaceOptions = {},
): Promise<SyncContext> {
    const rt = makeRuntime({
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        brandId: creds.brandId,
        brandRoot: dir,
        syncLayout: opts.syncLayout ?? 'flat',
        saveMode: opts.saveMode ?? 'draft',
        auth: creds.auth,
    });
    return await buildSyncContext(rt);
}

/**
 * Pull a brand's editable surface into `dir`: `pages/`, `components/`,
 * `scripts/`, `variables.json` and `.ef-state.json`, plus `assets/` only when
 * `opts.assets === true`. Never writes a credential.
 *
 * Assets default OFF because a brand's media library is far larger than the
 * handful of files a caller usually needs; {@link pullAssets} fetches those by
 * name instead.
 */
export async function materializeBrand(
    dir: string,
    creds: BrandCredentials,
    opts: WorkspaceOptions = {},
): Promise<void> {
    const includeAssets = opts.assets === true;
    const ctx = await openBrandWorkspace(dir, creds, { ...opts, assets: includeAssets });
    await pullAllPages(ctx);
    await pullAllComponents(ctx);
    await pullAllScripts(ctx);
    await pullVariables(ctx);
    if (includeAssets) await pullAllAssets(ctx);
    await ctx.state.save();
}

export interface PushDirOptions {
    /** Brand-root-relative paths to push (the caller computes these from its own diff). */
    changedRelPaths: string[];
    /** Save as draft. Default follows the runtime's saveMode (`'draft'`). */
    draft?: boolean;
    /** Skip the optimistic-concurrency guard. */
    force?: boolean;
}

/**
 * Push only the changed files back, through the same
 * `pushPageFile`/`pushComponentFile`/`pushScriptFile` machinery the CLI uses —
 * so 409 handling and canonical-body refetch behave identically rather than
 * drifting into a second implementation. Assets are skipped: they were
 * read-only reads. Pass the {@link SyncContext} from {@link openBrandWorkspace}.
 */
export async function pushDir(
    dir: string,
    ctx: SyncContext,
    opts: PushDirOptions,
): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (const rel of opts.changedRelPaths) {
        const abs = safeJoinBrandRoot(dir, rel);
        const cls = classifyAbsPath(dir, abs);
        if (!cls) continue;
        if (cls.kind === 'page') {
            results.push(await pushPageFile(ctx, abs, cls.rel, { draft: opts.draft, force: opts.force }));
        } else if (cls.kind === 'component') {
            results.push(await pushComponentFile(ctx, abs, cls.rel, { draft: opts.draft, force: opts.force }));
        } else if (cls.kind === 'script') {
            results.push(await pushScriptFile(ctx, abs, cls.rel, { force: opts.force }));
        }
        // cls.kind === 'asset' → skipped, see above.
    }
    await ctx.state.save();
    return results;
}
