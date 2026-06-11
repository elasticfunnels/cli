import * as path from 'path';
import { Command } from 'commander';
import { c, log } from '../utils/log';
import { CliError, ExitCode } from '../utils/exit';
import { loadRuntime, saveConfig } from '../utils/store';
import {
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

interface PullOpts {
    json?: boolean;
    since?: string;
}

export function registerPullCommand(program: Command): void {
    program
        .command('pull [target] [key]')
        .description(`Pull from server to disk. Without arguments, pulls everything (pages, components, scripts, assets, variables).
With <target>, pulls one entity. Examples:
  ef pull                       # full sync
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
        .action(async (target: string | undefined, key: string | undefined, opts: PullOpts) => {
            const rt = await loadRuntime();
            const ctx = await buildSyncContext(rt);

            const log_ = (msg: string) => { if (!opts.json) log.info(msg); };

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
                // Full sync.
                log_(`${c.bold('Full sync')} → ${ctx.rt.brandRoot}`);
                const pages = await pullAllPages(ctx);
                log_(`${c.green('✓')} ${pages.length} pages`);
                const components = await pullAllComponents(ctx);
                log_(`${c.green('✓')} ${components.length} components`);
                const scripts = await pullAllScripts(ctx);
                log_(`${c.green('✓')} ${scripts.length} scripts`);
                const assets = await pullAllAssets(ctx);
                log_(`${c.green('✓')} ${assets.length} assets`);
                const variables = await pullVariables(ctx);
                log_(`${c.green('✓')} variables → ${variables.rel}`);
                await ctx.state.save();
                const now = new Date().toISOString();
                rt.config.lastPulledAt = now;
                await saveConfig(rt.projectRoot, rt.config);
                if (opts.json) {
                    log.json({
                        ok: true,
                        brandRoot: rt.brandRoot,
                        pulled: {
                            pages: pages.length, components: components.length,
                            scripts: scripts.length, assets: assets.length, variables: 1,
                        },
                    });
                }
                return;
            }

            const t = target.trim();
            if (t === 'pages') {
                const out = await pullAllPages(ctx);
                await ctx.state.save();
                if (opts.json) { log.json({ ok: true, pulled: out.map(o => o.rel) }); return; }
                log.success(`Pulled ${out.length} pages.`);
                return;
            }
            if (t === 'components') {
                const out = await pullAllComponents(ctx);
                await ctx.state.save();
                if (opts.json) { log.json({ ok: true, pulled: out.map(o => o.rel) }); return; }
                log.success(`Pulled ${out.length} components.`);
                return;
            }
            if (t === 'scripts') {
                const out = await pullAllScripts(ctx);
                await ctx.state.save();
                if (opts.json) { log.json({ ok: true, pulled: out.map(o => o.rel) }); return; }
                log.success(`Pulled ${out.length} scripts.`);
                return;
            }
            if (t === 'assets') {
                const out = await pullAllAssets(ctx);
                await ctx.state.save();
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
        });
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
            const r = await pullPage(ctx, row.id);
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
    opts: { json?: boolean },
): Promise<void> {
    if (kind === 'page') {
        const ref = await resolvePageBySlug(ctx.api, ctx.rt.config.brandId, key);
        const out = await pullPage(ctx, ref.id);
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'component') {
        const ref = await resolveComponentByCodeOrName(ctx.api, ctx.rt.config.brandId, key);
        const out = await pullComponent(ctx, ref.id);
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'script') {
        const out = await pullScript(ctx, key);
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
    opts: { json?: boolean },
): Promise<void> {
    if (kind === 'page') {
        const slug = rel.slice('pages/'.length, rel.length - '.ef'.length);
        const ref = await resolvePageBySlug(ctx.api, ctx.rt.config.brandId, slug);
        const out = await pullPage(ctx, ref.id);
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'component') {
        const code = rel.slice('components/'.length, rel.length - '.ef'.length);
        const ref = await resolveComponentByCodeOrName(ctx.api, ctx.rt.config.brandId, code);
        const out = await pullComponent(ctx, ref.id);
        await ctx.state.save();
        if (opts.json) log.json({ ok: true, pulled: [out.rel] }); else log.success(`Pulled ${out.rel}.`);
        return;
    }
    if (kind === 'script') {
        const code = rel.slice('scripts/'.length, rel.length - '.js'.length);
        const out = await pullScript(ctx, code);
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
