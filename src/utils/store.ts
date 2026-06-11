import * as path from 'path';
import * as fs from 'fs';
import { CliError, ExitCode } from '../utils/exit';
import { ensureDir, ensureGitignoreEntry, fileExists, findUp, writeFileAtomic } from '../utils/fs';

/**
 * Folder-scoped CLI configuration. Each project gets its own
 * `.ef/config.json` near the project root. The lookup walks up from
 * `cwd` to find an existing one (Git-style); `ef init` writes a new
 * one to the current cwd if none exists.
 *
 * The file layout:
 *
 *   .ef/
 *   ├── config.json       # API URL, brand id, sync root, syncLayout, save mode
 *   ├── auth              # API key (chmod 0600)
 *
 *   `.ef-state.json` lives under the **brand root** (see `syncLayout` on EfConfig).
 *
 * The auth key is stored separately so the JSON can be safely committed
 * if the user really wants (it isn't by default — `.ef/` goes in
 * `.gitignore`), and so file permissions can be locked tighter than
 * the rest of the config.
 */

export interface EfConfig {
    /** Where the API lives. Defaults to prod. */
    apiUrl: string;
    /** The brand the project is bound to. Required for any API call. */
    brandId: number;
    /** Folder under the project root where pages/components/assets/scripts live. */
    syncRoot: string;
    /**
     * Disk layout under `syncRoot`:
     * - `nested` (default): `syncRoot/<brandId>/pages/…` — matches older `ef init` behaviour.
     * - `flat`: `syncRoot/pages/…` — matches the VS Code extension default (`syncToDisk.root` only; brand id is in settings + `.ef-state.json`).
     */
    syncLayout: 'nested' | 'flat';
    /** Save mode mirroring the extension. `direct` publishes immediately. */
    saveMode: 'draft' | 'direct';
    /** ISO timestamp of the last successful pull. Updated by `ef pull`. */
    lastPulledAt?: string | null;
}

export interface EfRuntime {
    /** Resolved project root (where `.ef/` lives). */
    projectRoot: string;
    /** Loaded config object. */
    config: EfConfig;
    /** Loaded API key (read from `.ef/auth`). */
    apiKey: string;
    /**
     * Directory that contains `pages/`, `components/`, `.ef-state.json`.
     * `nested`: projectRoot/syncRoot/brandId — `flat`: projectRoot/syncRoot
     */
    brandRoot: string;
}

export const CONFIG_DIR = '.ef';
export const CONFIG_FILENAME = 'config.json';
export const AUTH_FILENAME = 'auth';

const DEFAULT_API_URL = 'https://app.elasticfunnels.io';
const DEFAULT_SYNC_ROOT = 'elasticfunnels';
const DEFAULT_SAVE_MODE: EfConfig['saveMode'] = 'draft';

export function configDirFor(projectRoot: string): string {
    return path.join(projectRoot, CONFIG_DIR);
}

export function configPathFor(projectRoot: string): string {
    return path.join(projectRoot, CONFIG_DIR, CONFIG_FILENAME);
}

export function authPathFor(projectRoot: string): string {
    return path.join(projectRoot, CONFIG_DIR, AUTH_FILENAME);
}

/** Walks up from `start` until it finds a `.ef/config.json`. Returns
 *  the project root or null. Used by every command that needs auth. */
export function findProjectRoot(start: string = process.cwd()): string | null {
    return findUp(start, CONFIG_DIR);
}

export function computeBrandRoot(projectRoot: string, config: Pick<EfConfig, 'syncRoot' | 'syncLayout' | 'brandId'>): string {
    const base = path.join(projectRoot, config.syncRoot);
    if (config.syncLayout === 'flat') {
        return base;
    }
    return path.join(base, String(config.brandId));
}

export async function loadConfig(projectRoot: string): Promise<EfConfig> {
    const p = configPathFor(projectRoot);
    if (!(await fileExists(p))) {
        throw new CliError(ExitCode.Auth, `No ElasticFunnels config at ${p}. Run "ef init" first.`);
    }
    let raw: string;
    try {
        raw = await fs.promises.readFile(p, 'utf8');
    } catch (err) {
        throw new CliError(ExitCode.Error, `Failed to read ${p}: ${(err as Error).message}`);
    }
    let parsed: Partial<EfConfig>;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new CliError(ExitCode.Error, `Corrupt ElasticFunnels config at ${p}. Delete the file and run "ef init" again.`);
    }
    if (!parsed.brandId || typeof parsed.brandId !== 'number') {
        throw new CliError(ExitCode.Auth, `${p} is missing brandId. Run "ef init" again.`);
    }
    return {
        apiUrl: typeof parsed.apiUrl === 'string' && parsed.apiUrl.trim() !== '' ? parsed.apiUrl.trim() : DEFAULT_API_URL,
        brandId: parsed.brandId,
        syncRoot: typeof parsed.syncRoot === 'string' && parsed.syncRoot.trim() !== '' ? parsed.syncRoot.trim() : DEFAULT_SYNC_ROOT,
        syncLayout: parsed.syncLayout === 'flat' ? 'flat' : 'nested',
        saveMode: parsed.saveMode === 'direct' ? 'direct' : DEFAULT_SAVE_MODE,
        lastPulledAt: typeof parsed.lastPulledAt === 'string' ? parsed.lastPulledAt : null,
    };
}

export async function loadApiKey(projectRoot: string): Promise<string> {
    const p = authPathFor(projectRoot);
    if (!(await fileExists(p))) {
        throw new CliError(ExitCode.Auth, `No ElasticFunnels API key on disk. Run "ef init".`);
    }
    const raw = await fs.promises.readFile(p, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new CliError(ExitCode.Auth, `${p} is empty. Run "ef init" to set your API key.`);
    }
    return trimmed;
}

export async function loadRuntime(opts?: { startDir?: string }): Promise<EfRuntime> {
    const projectRoot = findProjectRoot(opts?.startDir);
    if (!projectRoot) {
        throw new CliError(
            ExitCode.Auth,
            'No ElasticFunnels project found. Run "ef init" inside the folder you want to bind, or cd into one that already has a .ef directory.',
        );
    }
    const config = await loadConfig(projectRoot);
    const apiKey = await loadApiKey(projectRoot);
    const brandRoot = computeBrandRoot(projectRoot, config);
    return { projectRoot, config, apiKey, brandRoot };
}

export async function saveConfig(projectRoot: string, config: EfConfig): Promise<void> {
    await ensureDir(configDirFor(projectRoot));
    const out = JSON.stringify(config, null, 2) + '\n';
    await writeFileAtomic(configPathFor(projectRoot), out);
}

export async function saveApiKey(projectRoot: string, apiKey: string): Promise<void> {
    await ensureDir(configDirFor(projectRoot));
    const p = authPathFor(projectRoot);
    await writeFileAtomic(p, apiKey + '\n');
    // Lock down permissions so only the owner can read the key. Best-effort:
    // on Windows / certain network filesystems chmod is a no-op but we still
    // try.
    try { await fs.promises.chmod(p, 0o600); } catch { /* tolerated */ }
}

/** Creates `.ef/` at `projectRoot`, writes config + auth, and adds `.ef/` to
 *  the project's `.gitignore` (creating the file if absent) so the API key
 *  isn't accidentally committed.
 *  Returns the resolved EfRuntime so callers can immediately use it. */
export async function persistLogin(args: {
    projectRoot: string;
    apiUrl: string;
    apiKey: string;
    brandId: number;
    syncRoot?: string;
    syncLayout?: EfConfig['syncLayout'];
    saveMode?: EfConfig['saveMode'];
}): Promise<EfRuntime> {
    const config: EfConfig = {
        apiUrl: args.apiUrl,
        brandId: args.brandId,
        syncRoot: args.syncRoot ?? DEFAULT_SYNC_ROOT,
        syncLayout: args.syncLayout === 'flat' ? 'flat' : 'nested',
        saveMode: args.saveMode ?? DEFAULT_SAVE_MODE,
        lastPulledAt: null,
    };
    await saveConfig(args.projectRoot, config);
    await saveApiKey(args.projectRoot, args.apiKey);

    // Make sure .ef/ is gitignored. We deliberately add to a gitignore at
    // the project root if one exists OR create one if `.git` is here.
    const gitignorePath = path.join(args.projectRoot, '.gitignore');
    const isGitRepo = await fileExists(path.join(args.projectRoot, '.git'));
    if (isGitRepo || (await fileExists(gitignorePath))) {
        try { await ensureGitignoreEntry(gitignorePath, '.ef'); } catch { /* tolerated */ }
    }

    return {
        projectRoot: args.projectRoot,
        config,
        apiKey: args.apiKey,
        brandRoot: computeBrandRoot(args.projectRoot, config),
    };
}

export async function clearLogin(projectRoot: string): Promise<void> {
    const cfgPath = configPathFor(projectRoot);
    const authPath = authPathFor(projectRoot);
    try { await fs.promises.unlink(authPath); } catch { /* tolerated */ }
    try { await fs.promises.unlink(cfgPath); } catch { /* tolerated */ }
    // Try to remove the directory if empty (it usually is at this point).
    try { await fs.promises.rmdir(configDirFor(projectRoot)); } catch { /* tolerated */ }
}

export const Defaults = {
    apiUrl: DEFAULT_API_URL,
    syncRoot: DEFAULT_SYNC_ROOT,
    saveMode: DEFAULT_SAVE_MODE,
};
