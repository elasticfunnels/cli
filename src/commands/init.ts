import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Brand } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { ask, confirm } from '../utils/prompt';
import { Defaults, EF_VSCODE_LANGUAGE, ensureEfFileAssociation, findProjectRoot, loadConfig, persistLogin, readVscodeEfSettings } from '../utils/store';
import { applyClaudeGuidance } from './claude';
import { loader } from '../utils/loader';
import { runFullSync } from './pull';

interface InitOptions {
    apiUrl?: string;
    apiKey?: string;
    brandId?: string;
    syncRoot?: string;
    /** `flat` matches VS Code: pages under syncRoot/pages/ (brand id only in config + .ef-state.json). */
    syncLayout?: string;
    saveMode?: string;
    nonInteractive?: boolean;
    inherit?: boolean;
    force?: boolean;
    /** Commander sets this to false when `--no-pull` is passed; defaults to true. */
    pull?: boolean;
    /** Commander sets this to false when `--no-claude` is passed; defaults to true. */
    claude?: boolean;
    json?: boolean;
}

/** Parse a user-supplied brand id (tolerates a leading `#`). */
function parseBrandId(raw: string, label: string): number {
    const n = parseInt(raw.trim().replace(/^#/, ''), 10);
    if (!Number.isFinite(n) || n <= 0) {
        throw new CliError(ExitCode.Validation, `Invalid ${label} — expected a positive numeric brand id.`);
    }
    return n;
}

/** Ask for the brand id when auto-detection didn't yield a single brand. */
async function promptBrandId(opts: InitOptions, choices: number): Promise<number> {
    if (opts.nonInteractive) {
        throw new CliError(ExitCode.Validation, '--brand-id is required in --non-interactive mode.');
    }
    if (process.stdin.isTTY !== true) {
        throw new CliError(ExitCode.Validation, 'No brand id provided and stdin is not a TTY. Pass --brand-id.');
    }
    const hint = choices > 1
        ? ' (this key maps to multiple brands — enter the one you want)'
        : ' (Settings → All Settings → API)';
    const answer = (await ask(`Enter the brand id this key belongs to${hint}`)).trim();
    return parseBrandId(answer, `brand id "${answer}"`);
}

/**
 * When binding a brand into a folder that already has unrelated files, warn
 * and ask for confirmation. Skipped with --force; in non-interactive / non-TTY
 * runs we warn and proceed (so CI isn't blocked). `.git`, `.gitignore`, `.ef`
 * and OS cruft don't count as "content".
 */
async function confirmFolderIfNotEmpty(dir: string, opts: InitOptions): Promise<void> {
    const ignorable = new Set(['.git', '.gitignore', '.ef', '.DS_Store', 'Thumbs.db']);
    let entries: string[] = [];
    try {
        entries = await fs.promises.readdir(dir);
    } catch {
        return; // unreadable dir — let the later write surface a real error
    }
    const leftover = entries.filter((e) => !ignorable.has(e));
    if (leftover.length === 0) return;

    const preview = leftover.slice(0, 6).join(', ') + (leftover.length > 6 ? `, …(${leftover.length} items)` : '');
    log.warn(`This folder isn't empty (${preview}). "ef init" will add a .ef/ config and an "${Defaults.syncRoot}/" tree here.`);

    if (opts.force) return;
    if (opts.nonInteractive || process.stdin.isTTY !== true) {
        log.detail('Proceeding (non-interactive). Pass --force to silence this warning.');
        return;
    }
    const ok = await confirm('Set up this brand in the current folder?', false);
    if (!ok) {
        throw new CliError(ExitCode.Validation, 'Aborted. Run "ef init" in a new or empty folder, or pass --force.');
    }
}

export function registerInitCommand(program: Command): void {
    program
        .command('init')
        .description('Bind the current folder to an ElasticFunnels brand. Writes .ef/config.json and .ef/auth (chmod 600 on Unix).')
        .option('--api-url <url>', `ElasticFunnels API base URL (default: ${Defaults.apiUrl}, or from .vscode/settings.json).`)
        .option('--api-key <key>', 'API key for the brand (Settings → All Settings → API). Can also be passed via $EF_API_KEY, or read from .vscode/settings.json.')
        .option('--brand-id <id>', 'Numeric brand id the key belongs to (shown next to the key on the API page; or read from .vscode/settings.json).')
        .option('--sync-root <dir>', `Folder under the project root where pages/components/assets/scripts live (default "${Defaults.syncRoot}", or from .vscode/settings.json).`)
        .option(
            '--sync-layout <flat|nested>',
            'Disk layout: flat = syncRoot/pages (default, matches VS Code); nested = syncRoot/brandId/pages.',
            'flat',
        )
        .option('--save-mode <mode>', `Default save mode for \`ef push\`: "draft" or "direct" (default: ${Defaults.saveMode}, or from .vscode/settings.json).`)
        .option('--non-interactive', 'Fail rather than prompt. Use with --api-key and --brand-id.')
        .option('--inherit', 'If a parent directory already has a .ef project, update its config in place instead of creating a new nested project.')
        .option('--force', 'Skip the "folder is not empty" confirmation prompt.')
        .option('--no-pull', 'Bind only — skip the initial full sync.')
        .option('--no-claude', 'Skip writing ElasticFunnels guidance into CLAUDE.md.')
        .option('--json', 'Print the resulting config as JSON.')
        .action(async (opts: InitOptions) => {
            await runInit(opts);
        });
}

async function runInit(opts: InitOptions): Promise<void> {
    let projectRoot = process.cwd();
    const existing = findProjectRoot(projectRoot);

    // Already bound right here — refuse rather than silently re-bind. Switching
    // brands should be an explicit `ef reset` first.
    if (existing === projectRoot) {
        let brandLabel = '';
        try {
            const cfg = await loadConfig(projectRoot);
            brandLabel = ` to brand #${cfg.brandId}`;
        } catch { /* config unreadable — still report it's bound */ }
        throw new CliError(
            ExitCode.Validation,
            `This folder is already bound${brandLabel} (.ef/ exists). Run "ef reset" first, or run "ef init" in a new folder.`,
        );
    }

    // A parent is bound. Either inherit it (update in place) or create a new
    // nested project here.
    let creatingHere = true;
    if (existing && existing !== projectRoot) {
        if (opts.inherit) {
            log.detail(`--inherit set; updating the existing project at ${existing}.`);
            projectRoot = existing;
            creatingHere = false;
        } else {
            log.warn(`Found an existing ElasticFunnels project at ${existing}. "ef init" here will create a NEW nested project at ${projectRoot}. Pass --inherit to update the existing one instead.`);
            if (opts.nonInteractive) {
                throw new CliError(ExitCode.Validation, 'Refusing to nest projects in --non-interactive mode. Pass --inherit to update the existing project, or run from the directory you actually want to bind.');
            }
        }
    }

    // Reuse an existing VS Code extension setup if one is present, so `ef init`
    // in an extension-configured folder "just works" instead of re-prompting for
    // a key/brand the user already configured. Explicit flags and $EF_API_KEY
    // always win over these.
    const vscodeSettings = await readVscodeEfSettings(projectRoot);
    const hasExtensionConfig = !!(vscodeSettings.apiKey && vscodeSettings.brandId);
    if (hasExtensionConfig) {
        log.info(`Found an existing VS Code setup in .vscode/settings.json (brand #${vscodeSettings.brandId}); reusing its credentials.`);
    }

    // Creating a fresh project in this folder. If it already has unrelated
    // content, make the user confirm so they don't accidentally scaffold a
    // brand into the wrong directory (e.g. their home folder). A detected
    // extension config is itself confirmation this is a real EF workspace, so
    // we skip the prompt in that case.
    if (creatingHere && !hasExtensionConfig) {
        await confirmFolderIfNotEmpty(projectRoot, opts);
    }

    const apiUrl = (opts.apiUrl || vscodeSettings.apiUrl || Defaults.apiUrl).trim();

    // Resolve API key: explicit flag > env var > .vscode/settings.json > prompt.
    // Block prompting when we can't actually drive a TTY masked input (CI, piped
    // stdin, no terminal) so the command exits with a clear error, not a hang.
    let apiKey = (opts.apiKey || process.env.EF_API_KEY || vscodeSettings.apiKey || '').trim();
    if (!apiKey) {
        if (opts.nonInteractive) {
            throw new CliError(ExitCode.Validation, '--api-key is required in --non-interactive mode (or set $EF_API_KEY).');
        }
        if (process.stdin.isTTY !== true) {
            throw new CliError(
                ExitCode.Validation,
                'No API key provided and stdin is not a TTY. Pass --api-key, set $EF_API_KEY, or run interactively.',
            );
        }
        apiKey = (await ask('Paste the API key for your brand (Settings → All Settings → API)', { mask: true })).trim();
    }

    if (!apiKey) throw new CliError(ExitCode.Validation, 'API key is required.');

    const api = new ApiClient(apiUrl, apiKey);

    // The API key is scoped to a single brand. When the server supports
    // key-scoping, GET /brands/all returns just that brand, so we can detect it
    // automatically. Otherwise (older server, or shared key) we ask, and an
    // explicit --brand-id always wins.
    let brandId: number;
    if (opts.brandId != null) {
        brandId = parseBrandId(opts.brandId, `--brand-id "${opts.brandId}"`);
    } else if (vscodeSettings.brandId != null) {
        brandId = vscodeSettings.brandId;
        log.info(`Using brand #${brandId} from .vscode/settings.json.`);
    } else {
        let brands: Brand[] = [];
        try { brands = await api.listBrands(); } catch { /* offline / unsupported — fall back to asking */ }
        if (brands.length === 1) {
            brandId = brands[0].id;
            log.info(`Detected brand ${brands[0].name} (#${brandId}).`);
        } else {
            brandId = await promptBrandId(opts, brands.length);
        }
    }

    // Verify the key actually works for this brand. The per-brand BrandAccess
    // middleware checks (api_key, brand_id) together, so this one call catches a
    // wrong key, a wrong brand id, or a key that belongs to a different brand.
    log.info(`Verifying access to brand #${brandId}…`);
    const ok = await api.ping(brandId).catch(() => false);
    if (!ok) {
        throw new CliError(
            ExitCode.Auth,
            `Could not access brand #${brandId} with that API key. Each brand has its own key — open Settings → All Settings → API for the brand you want, and use the key and brand id shown there.`,
        );
    }

    const saveModeRaw = opts.saveMode ?? vscodeSettings.saveMode;
    const saveMode = (saveModeRaw === 'draft' ? 'draft' : saveModeRaw === 'direct' ? 'direct' : Defaults.saveMode) as 'draft' | 'direct';
    const syncRoot = (opts.syncRoot || vscodeSettings.syncRoot || Defaults.syncRoot).trim() || Defaults.syncRoot;
    const layoutRaw = (opts.syncLayout ?? 'flat').trim().toLowerCase();
    if (layoutRaw !== 'nested' && layoutRaw !== 'flat') {
        throw new CliError(ExitCode.Validation, `--sync-layout must be "flat" or "nested", got "${opts.syncLayout ?? ''}".`);
    }
    const syncLayout = layoutRaw === 'nested' ? ('nested' as const) : ('flat' as const);

    const runtime = await persistLogin({
        projectRoot,
        apiUrl,
        apiKey,
        brandId,
        syncRoot,
        syncLayout,
        saveMode,
    });

    log.success(`Bound this folder to brand #${brandId} (${apiUrl}).`);
    log.detail(`Config: ${path.join(runtime.projectRoot, '.ef', 'config.json')}`);
    log.detail(`Brand root: ${runtime.brandRoot}`);

    // Make VS Code highlight `.ef` files (HTML + `{{ }}`) without needing the
    // extension. Best-effort — a failure here never undoes the bind.
    const vscodeAssoc = await ensureEfFileAssociation(runtime.projectRoot);
    if (vscodeAssoc === 'created' || vscodeAssoc === 'added') {
        log.detail(`VS Code: mapped *.ef → ${EF_VSCODE_LANGUAGE} in .vscode/settings.json (syntax highlighting).`);
        log.detail('For full .ef highlighting (@if/@foreach + {{ }}), run "ef install-highlighter".');
    }

    // Drop ElasticFunnels guidance into CLAUDE.md so Claude Code knows the
    // conventions (efmeta, template syntax, CLI). Idempotent; best-effort.
    let claudeAction: 'created' | 'updated' | 'appended' | null = null;
    if (opts.claude !== false) {
        try {
            claudeAction = await applyClaudeGuidance(path.join(runtime.projectRoot, 'CLAUDE.md'));
            log.detail(`CLAUDE.md ${claudeAction} — ElasticFunnels guidance for Claude Code (re-run with "ef claude").`);
        } catch { /* non-fatal */ }
    }

    // Bind, then pull everything down so the folder is usable immediately.
    // A sync failure doesn't undo the bind — the user can re-run `ef pull`.
    let pulled: { pages: number; components: number; scripts: number; assets: number } | null = null;
    if (opts.pull !== false) {
        if (!opts.json) log.info('');
        const ld = opts.json ? null : loader('Syncing');
        try {
            pulled = await runFullSync(runtime, {
                json: opts.json,
                silent: true,
                onProgress: (kind, label, done, total) => {
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    const name = label.split('/').pop() || label;
                    ld?.update(`${kind}s ${done}/${total} (${pct}%) · ${name}`);
                },
            });
            ld?.stop();
            if (pulled && !opts.json) {
                log.success(`Synced ${pulled.pages} pages, ${pulled.components} components, ${pulled.scripts} scripts, ${pulled.assets} assets → ${runtime.brandRoot}`);
            }
        } catch (err) {
            ld?.stop();
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`Bound OK, but the initial sync failed: ${msg}. Run "ef pull" to retry.`);
        }
    } else {
        log.detail('Skipped initial sync (--no-pull). Run "ef pull" when ready.');
    }

    if (opts.json) {
        log.json({
            ok: true,
            projectRoot: runtime.projectRoot,
            apiUrl: runtime.config.apiUrl,
            brandId: runtime.config.brandId,
            syncRoot: runtime.config.syncRoot,
            syncLayout: runtime.config.syncLayout,
            saveMode: runtime.config.saveMode,
            brandRoot: runtime.brandRoot,
            vscodeAssociation: vscodeAssoc,
            pulled,
        });
    }
}
