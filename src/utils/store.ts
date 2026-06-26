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
     * - `flat` (default): `syncRoot/pages/…` — matches the VS Code extension
     *   (brand id lives in config + `.ef-state.json`, not in the path).
     * - `nested`: `syncRoot/<brandId>/pages/…` — keeps several brands' files
     *   apart under one sync root (opt-in via `--sync-layout nested`).
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
const DEFAULT_SAVE_MODE: EfConfig['saveMode'] = 'direct';

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
        syncLayout: parsed.syncLayout === 'nested' ? 'nested' : 'flat',
        // Honor an explicit "draft" so upgrading (when the default flipped to
        // "direct") doesn't silently start publishing for users who chose draft.
        saveMode: parsed.saveMode === 'draft' ? 'draft' : parsed.saveMode === 'direct' ? 'direct' : DEFAULT_SAVE_MODE,
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
        syncLayout: args.syncLayout === 'nested' ? 'nested' : 'flat',
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

/** Subset of the VS Code extension's config the CLI can reuse on `ef init`. */
export interface VscodeEfSettings {
    apiKey?: string;
    brandId?: number;
    apiUrl?: string;
    saveMode?: 'draft' | 'direct';
    syncRoot?: string;
}

/**
 * Strip `//` and block comments and trailing commas so a VS Code `settings.json`
 * (JSONC) parses as JSON. String contents — e.g. a `"https://…"` value — are
 * matched and preserved, so the `//` inside a URL is never mistaken for a
 * comment.
 */
function stripJsonc(text: string): string {
    const noComments = text.replace(
        /("(?:\\.|[^"\\])*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
        (_m, str) => (str ? str : ''),
    );
    return noComments.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Best-effort read of an existing VS Code extension setup from
 * `<projectRoot>/.vscode/settings.json`, so `ef init` can reuse the brand a user
 * already configured in the extension instead of re-prompting — the two tools
 * then work interchangeably on the same folder. Returns `{}` when the file is
 * absent or unparseable. Never throws.
 */
export async function readVscodeEfSettings(projectRoot: string): Promise<VscodeEfSettings> {
    const p = path.join(projectRoot, '.vscode', 'settings.json');
    let raw: string;
    try {
        raw = await fs.promises.readFile(p, 'utf8');
    } catch {
        return {};
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') return {};

    const out: VscodeEfSettings = {};

    const apiKey = parsed['elasticfunnels.apiKey'];
    if (typeof apiKey === 'string' && apiKey.trim() !== '') out.apiKey = apiKey.trim();

    const brandId = parsed['elasticfunnels.brandId'];
    if (typeof brandId === 'number' && Number.isFinite(brandId) && brandId > 0) {
        out.brandId = brandId;
    } else if (typeof brandId === 'string' && brandId.trim() !== '') {
        const n = parseInt(brandId.trim().replace(/^#/, ''), 10);
        if (Number.isFinite(n) && n > 0) out.brandId = n;
    }

    const apiUrl = parsed['elasticfunnels.apiUrl'];
    if (typeof apiUrl === 'string' && apiUrl.trim() !== '') out.apiUrl = apiUrl.trim();

    // The extension also supports "ask"; the CLI has no interactive save prompt,
    // so anything other than an explicit "direct" maps to the safe "draft".
    const saveMode = parsed['elasticfunnels.saveMode'];
    if (saveMode === 'direct') out.saveMode = 'direct';
    else if (saveMode === 'draft') out.saveMode = 'draft';

    const syncRoot = parsed['elasticfunnels.syncToDisk.root'];
    if (typeof syncRoot === 'string' && syncRoot.trim() !== '') out.syncRoot = syncRoot.trim();

    return out;
}

/**
 * Language we map `*.ef` files to in VS Code. Their bodies are HTML with `{{ }}`
 * interpolations, so the built-in Handlebars grammar highlights both the markup
 * and the expressions without needing a custom extension. (The engine's
 * `@if`/`@foreach` directives have no built-in grammar, so those stay
 * uncoloured — a dedicated TextMate grammar in the VS Code extension would be
 * needed to highlight them.)
 */
export const EF_VSCODE_LANGUAGE = 'handlebars';

/** What `ensureEfFileAssociation` did, for logging. `null` means a no-op/error. */
export type EfAssociationResult = 'created' | 'added' | 'already-set' | 'skipped-different';

/**
 * Best-effort: ensure `<projectRoot>/.vscode/settings.json` maps `*.ef` to a
 * language so VS Code highlights it, even for users who don't run the extension.
 *
 * Uses a minimal text merge — it inserts a single key rather than reparsing and
 * rewriting the file — so existing settings, formatting and `//` comments are
 * preserved. The edit is index-based, so as a safety net the result is
 * re-parsed before writing; if anything looks off we abort rather than risk
 * corrupting the user's settings. Never throws, and never overrides an existing
 * `*.ef` association the user set themselves. Returns `null` on any I/O error.
 */
export async function ensureEfFileAssociation(projectRoot: string): Promise<EfAssociationResult | null> {
    const dir = path.join(projectRoot, '.vscode');
    const p = path.join(dir, 'settings.json');

    let raw: string | null;
    try {
        raw = await fs.promises.readFile(p, 'utf8');
    } catch {
        raw = null; // absent (or unreadable) — create a fresh file below
    }

    // No settings file yet → write a minimal one.
    if (raw == null) {
        const body = `{\n  "files.associations": {\n    "*.ef": "${EF_VSCODE_LANGUAGE}"\n  }\n}\n`;
        try {
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(p, body, 'utf8');
            return 'created';
        } catch {
            return null;
        }
    }

    // Inspect current state with a tolerant parse. If it won't parse, don't risk
    // a blind text edit.
    let assoc: Record<string, unknown> | undefined;
    try {
        const parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
        const a = parsed?.['files.associations'];
        if (a && typeof a === 'object') assoc = a as Record<string, unknown>;
    } catch {
        return null;
    }

    // Already mapped → respect the user's choice, do nothing.
    if (assoc && Object.prototype.hasOwnProperty.call(assoc, '*.ef')) {
        return assoc['*.ef'] === EF_VSCODE_LANGUAGE ? 'already-set' : 'skipped-different';
    }

    let next: string;
    if (assoc) {
        // `files.associations` exists but lacks `*.ef` — insert into that object.
        const keyIdx = raw.search(/["']files\.associations["']\s*:/);
        const braceIdx = keyIdx >= 0 ? raw.indexOf('{', keyIdx) : -1;
        if (braceIdx < 0) return null;
        const insertion = `\n    "*.ef": "${EF_VSCODE_LANGUAGE}",`;
        next = raw.slice(0, braceIdx + 1) + insertion + raw.slice(braceIdx + 1);
    } else {
        // No `files.associations` key — insert one at the top of the root object.
        const braceIdx = raw.indexOf('{');
        if (braceIdx < 0) return null;
        const insertion = `\n  "files.associations": { "*.ef": "${EF_VSCODE_LANGUAGE}" },`;
        next = raw.slice(0, braceIdx + 1) + insertion + raw.slice(braceIdx + 1);
    }

    // Safety net: only write if the result still parses and now has our mapping
    // (guards against the index-based insert landing in the wrong place, e.g. a
    // `{` inside a leading comment).
    try {
        const check = JSON.parse(stripJsonc(next)) as Record<string, unknown>;
        const a = check?.['files.associations'] as Record<string, unknown> | undefined;
        if (!a || a['*.ef'] !== EF_VSCODE_LANGUAGE) return null;
    } catch {
        return null;
    }

    try {
        await fs.promises.writeFile(p, next, 'utf8');
        return 'added';
    } catch {
        return null;
    }
}
