import * as path from 'path';
import { Command } from 'commander';
import { c, log } from '../utils/log';
import { CliError, ExitCode } from '../utils/exit';
import { EfRuntime, loadRuntime, saveConfig } from '../utils/store';
import {
    SyncContext,
    buildSyncContext,
    pullAllAssets,
    pullAllComponents,
    pullAllPages,
    pullAllScripts,
    pullAsset,
    pullComponent,
    pullPage,
    pullScript,
    pullVariables,
} from '../sync/sync';
import { resolveComponentByCodeOrName, resolvePageBySlug } from './shared';
import { classifyAbsPath } from '../sync/sync';
import { pullEventsForAllPages } from './pageEvents';
import { withReauth } from './authFlow';
import { guidanceVersion, refreshGuidanceIfStale } from './claude';

interface PullOpts {
    json?: boolean;
    since?: string;
    adopt?: boolean;
    force?: boolean;
    merge?: boolean;
    events?: boolean;
    /** Commander gives this to us as a string; parsed in the action. */
    ifStale?: string;
}

/** Make a pull exit non-zero (and warn loudly) if any entity FAILED to fetch —
 *  so a mid-sync network/server error can't masquerade as a clean success. */
function reportPullFailures(ctx: SyncContext): void {
    if (ctx.stats.failed > 0) {
        process.exitCode = ExitCode.Server;
        log.warn(`${ctx.stats.failed} item${ctx.stats.failed === 1 ? '' : 's'} FAILED to pull and ${ctx.stats.failed === 1 ? 'is' : 'are'} missing or stale locally (exit ${ExitCode.Server}). Re-run "ef pull" to retry.`);
    }
}

/**
 * Pull every entity (pages, components, scripts, assets, variables) to disk and
 * update the baseline + lastPulledAt. Shared by `ef pull` (no target) and
 * `ef init` (the post-bind sync). Streams a ✓ line per kind unless `json`.
 */
export async function runFullSync(rt: EfRuntime, opts: {
    json?: boolean;
    silent?: boolean;
    /** Adopt an already-synced folder: skip re-downloading files already on disk
     *  and unchanged (used by `ef init` on an extension-populated folder). */
    adopt?: boolean;
    /** Overwrite local files even when they have unpushed edits (drift). */
    force?: boolean;
    /** 3-way merge server changes into locally-edited files (git-style markers). */
    merge?: boolean;
    onProgress?: SyncContext['onProgress'];
} = {}): Promise<{
    pages: number; components: number; scripts: number; assets: number;
}> {
    const ctx = await buildSyncContext(rt);
    ctx.onProgress = opts.onProgress;
    // `silent` suppresses the per-kind streaming so a caller (e.g. `ef init`)
    // can show its own loader instead.
    const log_ = (msg: string) => { if (!opts.json && !opts.silent) log.info(msg); };
    const a = { adopt: opts.adopt, force: opts.force, merge: opts.merge };
    const summary = (kind: string, arr: Array<{ skipped?: boolean }>): string => {
        const skipped = arr.filter((x) => x.skipped).length;
        return skipped ? `${arr.length} ${kind} (${arr.length - skipped} fetched, ${skipped} already current)` : `${arr.length} ${kind}`;
    };

    const counts = { pages: 0, components: 0, scripts: 0, assets: 0 };
    const stages: Array<{ key: keyof typeof counts; run: () => Promise<Array<{ skipped?: boolean }>> }> = [
        { key: 'pages', run: () => pullAllPages(ctx, a) },
        { key: 'components', run: () => pullAllComponents(ctx, a) },
        { key: 'scripts', run: () => pullAllScripts(ctx, a) },
        { key: 'assets', run: () => pullAllAssets(ctx, a) },
    ];

    /*
     * Ctrl-C during a sync used to lose every baseline for the files that had
     * already been written: `state.save()` ran only at the very end, so the
     * tree was left populated but unrecorded. Handle the signal cooperatively —
     * let in-flight requests finish, stop starting new ones, and always flush
     * the state file on the way out.
     *
     * A second Ctrl-C means the user wants out now, not a tidy shutdown.
     */
    let hardExit = false;
    const onInterrupt = (): void => {
        if (hardExit) process.exit(ExitCode.Interrupted);
        hardExit = true;
        ctx.aborted = 'interrupt';
        if (!opts.json) log.warn('\nInterrupted — finishing in-flight downloads and saving progress…');
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);

    let completed = false;
    try {
        log_(`${c.bold('Full sync')}${opts.adopt ? ' (adopting existing files)' : ''} → ${ctx.rt.brandRoot}`);
        for (const stage of stages) {
            if (ctx.aborted) break;
            const arr = await stage.run();
            counts[stage.key] = arr.length;
            log_(`${c.green('✓')} ${summary(stage.key, arr)}`);
        }
        if (!ctx.aborted) {
            const variables = await pullVariables(ctx);
            log_(`${c.green('✓')} variables → ${variables.rel}`);
            completed = true;
        }
    } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
        // Runs on success, on abort, AND on a thrown error (a 401 from a list
        // call, a dropped connection). Whatever reached disk gets its baseline
        // recorded, so the next pull sees an accurate picture instead of
        // treating every file as unknown.
        try {
            await ctx.state.save();
        } catch (err) {
            log.warn(`Could not save sync state: ${err instanceof Error ? err.message : String(err)}. The next pull will re-fetch.`);
        }
        // Only a complete sync is "a pull". Stamping this on a partial run would
        // let `--if-stale` skip the retry the user needs.
        if (completed) {
            rt.config.lastPulledAt = new Date().toISOString();
            await saveConfig(rt.projectRoot, rt.config);
        }
    }

    if (ctx.aborted === 'interrupt') {
        throw new CliError(
            ExitCode.Interrupted,
            `Stopped. ${counts.pages} pages, ${counts.components} components, ${counts.scripts} scripts, ${counts.assets} assets were saved and recorded — re-run "ef pull" to finish (already-current files are skipped).`,
        );
    }
    if (ctx.aborted === 'auth') {
        throw new CliError(ExitCode.Auth, 'Credential was rejected partway through the sync, so it was stopped.');
    }

    reportPullFailures(ctx);
    return counts;
}

export function registerPullCommand(program: Command): void {
    program
        .command('pull [target] [key]')
        .description('Pull from server to disk. No args = full sync; <target> pulls one kind or entity.')
        .addHelpText('after', `
Examples:
  ef pull                       # full sync (pages, components, scripts, assets, variables)
  ef pull pages                 # all pages
  ef pull components            # all components
  ef pull scripts               # all backend scripts
  ef pull assets                # all assets
  ef pull variables             # brand variables
  ef pull pages/about-us.ef     # one specific page (by path)
  ef pull page about-us         # one specific page (by slug)
  ef pull component header      # one specific component
  ef pull script welcome-email  # one specific script`)
        .option('--json', 'Print results as JSON.')
        .option('--since <iso>', 'Only pull entities modified after this ISO timestamp. Uses the server\'s sync-delta endpoints — much faster than a full sync for incremental updates.')
        .option('--adopt', 'Skip re-downloading files already on disk and unchanged (resume, or adopt an existing/extension folder). Only fetches what is missing or drifted.')
        .option('--force', 'Overwrite local files even if they have unpushed changes (a copy is saved to .ef-history). Without this, pull keeps locally-edited files and warns.')
        .option('--merge', 'For locally-edited files, 3-way merge the server version into yours (git-style conflict markers on overlap) instead of keeping local and warning.')
        .option('--events', 'Also pull each page\'s events graph to pages/<slug>.events.json (funnel builder / split tests). Off by default.')
        .option('--if-stale <minutes>', 'Do nothing if the last pull was more recent than this. Cheap enough to run on every session start — see the hook `ef claude` installs.')
        .action(async (target: string | undefined, key: string | undefined, opts: PullOpts) => {
            const rt = await loadRuntime();

            // Re-stamp CLAUDE.md / AGENTS.md if they were written by an older
            // CLI. Done here, before the --if-stale shortcut, because the
            // SessionStart hook's usual outcome is "already fresh, exit" — and
            // that is precisely the moment an agent is about to read them.
            try {
                const refreshed = await refreshGuidanceIfStale(rt.projectRoot);
                if (refreshed.length && !opts.json) {
                    log.detail(`Updated ${refreshed.join(' + ')} for CLI v${guidanceVersion()}.`);
                }
            } catch { /* guidance is a convenience; never block a pull */ }

            // Checked before anything touches the network: the point of
            // --if-stale is that the common case costs one config read, so it
            // can sit on a session-start hook without being felt.
            if (opts.ifStale != null) {
                const minutes = Number(opts.ifStale);
                if (!Number.isFinite(minutes) || minutes < 0) {
                    throw new CliError(ExitCode.Validation, `--if-stale expects a number of minutes, got "${opts.ifStale}".`);
                }

                const last = rt.config.lastPulledAt ? Date.parse(rt.config.lastPulledAt) : NaN;
                // Never pulled → treat as infinitely stale and pull.
                const ageMs = Number.isFinite(last) ? Date.now() - last : Infinity;

                if (ageMs < minutes * 60_000) {
                    const ageMin = Math.round(ageMs / 60_000);
                    if (opts.json) {
                        log.json({ ok: true, skipped: true, reason: 'fresh', lastPulledAt: rt.config.lastPulledAt, ageMinutes: ageMin });
                    } else {
                        log.detail(`Already up to date (last pull ${ageMin}m ago).`);
                    }
                    return;
                }
            }

            // Everything past this point talks to the API, so any of it can hit
            // a rejected credential. Wrapping the whole body once means an
            // interactive user is offered a re-login and the pull is retried,
            // while a script or the SessionStart hook still just gets the error.
            await withReauth(rt, opts, (active) => runPull(active, target, key, opts));
        });
}

/**
 * The body of `ef pull`, past the freshness check.
 *
 * Split out so it can be re-run verbatim against a fresh credential after an
 * interactive re-login — see `withReauth`. Takes the runtime as a parameter
 * rather than closing over it for exactly that reason: the retry must use the
 * new key, not the dead one.
 */
async function runPull(rt: EfRuntime, target: string | undefined, key: string | undefined, opts: PullOpts): Promise<void> {
    const ctx = await buildSyncContext(rt);

    // Validate --since up front so a typo doesn't silently disable the filter.
    const sinceIso = opts.since ? validateIso(opts.since) : null;

    if (sinceIso != null && (!target || target === 'pages' || target === 'assets')) {
        const scope = (target === 'pages' || target === 'assets') ? target : 'all';
        return await runIncrementalPull(ctx, rt, scope, sinceIso, opts);
    }
    if (sinceIso != null) {
        throw new CliError(ExitCode.Validation, `--since only supports the 'pages' and 'assets' kinds (the API only exposes sync-delta for those). Got target="${target}".`);
    }

    if (!target) {
        const r = await runFullSync(rt, opts);
        const events = opts.events ? await pullEventsForAllPages(rt, ctx.api) : [];
        if (opts.events && !opts.json) log.info(`  pulled events for ${events.length} page(s)`);
        if (opts.json) {
            log.json({ ok: true, brandRoot: rt.brandRoot, pulled: { ...r, variables: 1, events: events.length } });
        }
        return;
    }

    const t = target.trim();
    if (t === 'pages') {
        const out = await pullAllPages(ctx, { adopt: opts.adopt, force: opts.force, merge: opts.merge });
        const events = opts.events ? await pullEventsForAllPages(rt, ctx.api) : [];
        await ctx.state.save();
        reportPullFailures(ctx);
        if (opts.json) { log.json({ ok: true, pulled: out.map(o => o.rel), events: events.length }); return; }
        log.success(`Pulled ${out.length} pages.${opts.events ? ` Events for ${events.length}.` : ''}`);
        return;
    }
    if (t === 'components') {
        const out = await pullAllComponents(ctx, { adopt: opts.adopt, force: opts.force, merge: opts.merge });
        await ctx.state.save();
        reportPullFailures(ctx);
        if (opts.json) { log.json({ ok: true, pulled: out.map(o => o.rel) }); return; }
        log.success(`Pulled ${out.length} components.`);
        return;
    }
    if (t === 'scripts') {
        const out = await pullAllScripts(ctx, { adopt: opts.adopt, force: opts.force, merge: opts.merge });
        await ctx.state.save();
        reportPullFailures(ctx);
        if (opts.json) { log.json({ ok: true, pulled: out.map(o => o.rel) }); return; }
        log.success(`Pulled ${out.length} scripts.`);
        return;
    }
    if (t === 'assets') {
        const out = await pullAllAssets(ctx, { adopt: opts.adopt });
        await ctx.state.save();
        reportPullFailures(ctx);
        if (opts.json) { log.json({ ok: true, pulled: out.map(o => o.rel) }); return; }
        log.success(`Pulled ${out.length} assets.`);
        return;
    }
    if (t === 'variables') {
        const v = await pullVariables(ctx);
        await ctx.state.save();
        if (opts.json) { log.json({ ok: true, pulled: [v.rel] }); return; }
        log.success(`Pulled variables → ${v.rel}.`);
        return;
    }

    // Targeted single-entity forms: `ef pull page <slug>`, `ef pull component <code>`, etc.
    if (key && (t === 'page' || t === 'component' || t === 'script' || t === 'asset')) {
        return await pullByKindAndKey(ctx, t as 'page' | 'component' | 'script' | 'asset', key, opts);
    }
    if (key) {
        throw new CliError(ExitCode.Validation, `Unexpected extra argument "${key}". Use one of: pages, components, scripts, assets, variables, page <slug>, component <code>, script <code>, asset <path>.`);
    }

    // Path-based: did the user pass `pages/about-us.ef`?
    const abs = path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
    const cls = classifyAbsPath(rt.brandRoot, abs) ?? classifyRelative(rt.brandRoot, t);
    if (!cls) {
        throw new CliError(ExitCode.Validation, `Don't know how to pull "${t}". Try: ef pull pages | ef pull page <slug> | ef pull pages/<slug>.ef`);
    }
    return await pullByKindAndPath(ctx, cls.kind, cls.rel, opts);
}

function validateIso(value: string): string {
    const trimmed = value.trim();
    const ts = Date.parse(trimmed);
    if (!Number.isFinite(ts)) {
        throw new CliError(ExitCode.Validation, `--since "${value}" is not a valid ISO timestamp (e.g. 2026-01-15T10:00:00Z).`);
    }
    return new Date(ts).toISOString();
}

async function runIncrementalPull(
    ctx: Awaited<ReturnType<typeof buildSyncContext>>,
    rt: Awaited<ReturnType<typeof loadRuntime>>,
    scope: 'all' | 'pages' | 'assets',
    sinceIso: string,
    opts: PullOpts,
): Promise<void> {
    const log_ = (msg: string) => { if (!opts.json) log.info(msg); };
    log_(`${c.bold('Incremental pull')} since=${sinceIso}`);

    const out: { pages: string[]; assets: string[] } = { pages: [], assets: [] };

    if (scope === 'all' || scope === 'pages') {
        const delta = await ctx.api.getPagesSyncDelta(rt.config.brandId, sinceIso);
        for (const row of delta) {
            const r = await pullPage(ctx, row.id, { force: opts.force, merge: opts.merge });
            out.pages.push(r.rel);
            if (!opts.json) log.detail(`  page  ${r.rel}`);
        }
        log_(`${c.green('✓')} ${out.pages.length} pages updated`);
    }

    if (scope === 'all' || scope === 'assets') {
        const delta = await ctx.api.getAssetsSyncDelta(rt.config.brandId, sinceIso);
        for (const row of delta) {
            const r = await pullAsset(ctx, row.id);
            if (r) {
                out.assets.push(r.rel);
                if (!opts.json) log.detail(`  asset ${r.rel}`);
            }
        }
        log_(`${c.green('✓')} ${out.assets.length} assets updated`);
    }

    await ctx.state.save();
    if (opts.json) { log.json({ ok: true, since: sinceIso, pulled: out }); return; }
    log.success(`Incremental pull done: ${out.pages.length} pages + ${out.assets.length} assets.`);
}

function classifyRelative(brandRoot: string, target: string): { kind: 'page' | 'component' | 'script' | 'asset'; rel: string } | null {
    const rel = target.replace(/\\/g, '/').replace(/^\/+/, '');
    void brandRoot;
    if (rel.startsWith('pages/') && rel.toLowerCase().endsWith('.ef')) return { kind: 'page', rel };
    if (rel.startsWith('components/') && rel.toLowerCase().endsWith('.ef')) return { kind: 'component', rel };
    if (rel.startsWith('scripts/') && rel.toLowerCase().endsWith('.js')) return { kind: 'script', rel };
    if (rel.startsWith('assets/')) return { kind: 'asset', rel };
    return null;
}

async function pullByKindAndKey(
    ctx: Awaited<ReturnType<typeof buildSyncContext>>,
    kind: 'page' | 'component' | 'script' | 'asset',
    key: string,
    opts: { json?: boolean; force?: boolean; merge?: boolean },
): Promise<void> {
    if (kind === 'page') {
        const ref = await resolvePageBySlug(ctx.api, ctx.rt.config.brandId, key);
        const out = await pullPage(ctx, ref.id, { force: opts.force, merge: opts.merge });
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'component') {
        const ref = await resolveComponentByCodeOrName(ctx.api, ctx.rt.config.brandId, key);
        const out = await pullComponent(ctx, ref.id, { force: opts.force, merge: opts.merge });
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'script') {
        const out = await pullScript(ctx, key, { force: opts.force, merge: opts.merge });
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    // asset
    const ref = await ctx.api.getAssetByPath(ctx.rt.config.brandId, key);
    if (!ref) throw new CliError(ExitCode.NotFound, `Asset "${key}" not found.`);
    const out = await pullAsset(ctx, ref.id);
    await ctx.state.save();
    if (opts.json) log.json({ ok: true, pulled: [out?.rel] }); else log.success(`Pulled ${out?.rel}.`);
}

async function pullByKindAndPath(
    ctx: Awaited<ReturnType<typeof buildSyncContext>>,
    kind: 'page' | 'component' | 'script' | 'asset',
    rel: string,
    opts: { json?: boolean; force?: boolean; merge?: boolean },
): Promise<void> {
    if (kind === 'page') {
        const slug = rel.slice('pages/'.length, rel.length - '.ef'.length);
        const ref = await resolvePageBySlug(ctx.api, ctx.rt.config.brandId, slug);
        const out = await pullPage(ctx, ref.id, { force: opts.force, merge: opts.merge });
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'component') {
        const code = rel.slice('components/'.length, rel.length - '.ef'.length);
        const ref = await resolveComponentByCodeOrName(ctx.api, ctx.rt.config.brandId, code);
        const out = await pullComponent(ctx, ref.id, { force: opts.force, merge: opts.merge });
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'script') {
        const code = rel.slice('scripts/'.length, rel.length - '.js'.length);
        const out = await pullScript(ctx, code, { force: opts.force, merge: opts.merge });
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    const remote = rel.slice('assets/'.length);
    const ref = await ctx.api.getAssetByPath(ctx.rt.config.brandId, remote);
    if (!ref) throw new CliError(ExitCode.NotFound, `Asset "${remote}" not found.`);
    const out = await pullAsset(ctx, ref.id);
    await ctx.state.save();
    if (opts.json) log.json({ ok: true, pulled: [out?.rel] }); else log.success(`Pulled ${out?.rel}.`);
}
