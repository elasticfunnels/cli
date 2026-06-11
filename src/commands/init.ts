import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log, c } from '../utils/log';
import { ask, confirm, pickOne } from '../utils/prompt';
import { Defaults, findProjectRoot, loadConfig, persistLogin } from '../utils/store';

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
    json?: boolean;
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
        .option('--api-url <url>', `ElasticFunnels API base URL`, Defaults.apiUrl)
        .option('--api-key <key>', 'API key for the brand (find it under brand settings → API). Can also be passed via $EF_API_KEY.')
        .option('--brand-id <id>', 'Numeric brand id to bind this folder to.')
        .option('--sync-root <dir>', `Folder under the project root where pages/components/assets/scripts live (default "${Defaults.syncRoot}").`, Defaults.syncRoot)
        .option(
            '--sync-layout <nested|flat>',
            'Disk layout: nested = syncRoot/brandId/pages (default); flat = syncRoot/pages (same as VS Code extension).',
            'nested',
        )
        .option('--save-mode <mode>', 'Default save mode for `ef push`: "draft" or "direct".', Defaults.saveMode)
        .option('--non-interactive', 'Fail rather than prompt. Use with --api-key and --brand-id.')
        .option('--inherit', 'If a parent directory already has a .ef project, update its config in place instead of creating a new nested project.')
        .option('--force', 'Skip the "folder is not empty" confirmation prompt.')
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

    // Creating a fresh project in this folder. If it already has unrelated
    // content, make the user confirm so they don't accidentally scaffold a
    // brand into the wrong directory (e.g. their home folder).
    if (creatingHere) {
        await confirmFolderIfNotEmpty(projectRoot, opts);
    }

    const apiUrl = (opts.apiUrl || Defaults.apiUrl).trim();

    // Resolve API key: explicit flag > env var > prompt. Block prompting when
    // we can't actually drive a TTY masked input (CI, piped stdin, no terminal)
    // so the command exits with a clear error instead of hanging.
    let apiKey = (opts.apiKey || process.env.EF_API_KEY || '').trim();
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
        apiKey = (await ask('Paste the API key for your brand', { mask: true })).trim();
    }

    if (!apiKey) throw new CliError(ExitCode.Validation, 'API key is required.');

    const api = new ApiClient(apiUrl, apiKey);

    // Validate the key by listing brands. If the user fat-fingered it, this
    // will tell them now instead of on the first push.
    log.info('Verifying credentials…');
    let brands = await api.listBrands();
    if (brands.length === 0) {
        throw new CliError(ExitCode.Auth, 'API key is valid but the user has no brands. Create or join a brand in the dashboard first.');
    }

    let brandId: number | undefined;
    const requested = opts.brandId ? parseInt(opts.brandId, 10) : undefined;
    if (requested != null && !Number.isFinite(requested)) {
        throw new CliError(ExitCode.Validation, `Invalid --brand-id: "${opts.brandId}".`);
    }
    if (requested) {
        const match = brands.find(b => b.id === requested);
        if (!match) {
            throw new CliError(ExitCode.Validation, `Brand id ${requested} is not on the list this API key can access. Available: ${brands.map(b => `${b.id} (${b.name})`).join(', ')}`);
        }
        brandId = match.id;
    } else if (opts.nonInteractive) {
        if (brands.length === 1) {
            brandId = brands[0].id;
        } else {
            throw new CliError(ExitCode.Validation, `Multiple brands available, --brand-id is required in --non-interactive mode. Choices: ${brands.map(b => `${b.id} (${b.name})`).join(', ')}`);
        }
    } else if (process.stdin.isTTY !== true) {
        if (brands.length === 1) {
            brandId = brands[0].id;
        } else {
            throw new CliError(
                ExitCode.Validation,
                `Multiple brands available and stdin is not a TTY. Pass --brand-id. Choices: ${brands.map(b => `${b.id} (${b.name})`).join(', ')}`,
            );
        }
    } else {
        // Sort brands by name so the prompt is stable across runs.
        brands = brands.slice().sort((a, b) => a.name.localeCompare(b.name));
        brandId = await pickOne('Pick a brand for this folder:', brands.map(b => ({
            name: `${b.name}  ${c.dim(`#${b.id}`)}${b.domain ? c.dim(`  ${b.domain}`) : ''}`,
            value: b.id,
        })));
    }

    if (!brandId) throw new CliError(ExitCode.Validation, 'No brand selected.');

    // Confirm the chosen brand really is reachable with this key. The /brands/all
    // endpoint can accept a key for any brand the user is in, but the per-brand
    // BrandAccess middleware checks (api_key, brand_id) tightly — so a key from
    // brand A may fail to authenticate to brand B even if both are on the list.
    log.info(`Checking access to brand #${brandId}…`);
    const ok = await api.ping(brandId).catch(() => false);
    if (!ok) {
        const chosen = brands.find(b => b.id === brandId);
        const chosenLabel = chosen ? `${chosen.name} (#${chosen.id})` : `#${brandId}`;
        throw new CliError(
            ExitCode.Auth,
            `That API key cannot operate on ${chosenLabel}. Each brand has its own API key — open the brand's settings → API page and use the key shown there.`,
        );
    }

    const saveMode = (opts.saveMode === 'direct' ? 'direct' : 'draft') as 'draft' | 'direct';
    const syncRoot = (opts.syncRoot || Defaults.syncRoot).trim() || Defaults.syncRoot;
    const layoutRaw = (opts.syncLayout ?? 'nested').trim().toLowerCase();
    if (layoutRaw !== 'nested' && layoutRaw !== 'flat') {
        throw new CliError(ExitCode.Validation, `--sync-layout must be "nested" or "flat", got "${opts.syncLayout ?? ''}".`);
    }
    const syncLayout = layoutRaw === 'flat' ? ('flat' as const) : ('nested' as const);

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
        });
    }
}
