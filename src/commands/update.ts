import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { PKG, fetchLatestVersion, isNewer } from '../utils/updateNotifier';

/**
 * `ef update` — upgrade the CLI in place.
 *
 * The update notifier can only ever say "a newer version exists"; acting on it
 * meant remembering which package manager put `ef` on your PATH. This command
 * answers that question from the install location itself and runs the matching
 * install, so the nudge has a one-word follow-through.
 *
 * The important part is knowing when NOT to run. A global install is the only
 * thing safe to upgrade behind the user's back: upgrading a project-local copy
 * would desync it from that project's lockfile, and "upgrading" a source
 * checkout or an `npm link` would overwrite someone's working tree with a
 * published tarball. Those three cases refuse and print the command that is
 * actually correct for them.
 */

type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * How each manager spells "install this exact version globally".
 *
 * Pinned to the resolved version rather than `@latest` so the run is
 * deterministic — the version we print is the version that gets installed,
 * even if a release lands between the registry check and the install.
 */
const INSTALL_ARGS: Record<Manager, (spec: string) => string[]> = {
    npm: (spec) => ['install', '--global', spec],
    pnpm: (spec) => ['add', '--global', spec],
    yarn: (spec) => ['global', 'add', spec],
    bun: (spec) => ['add', '--global', spec],
};

/**
 * The npm prefix that owns an install, recovered from its path.
 *
 * Global npm layout is `<prefix>/lib/node_modules/<pkg>` (`<prefix>/node_modules/<pkg>`
 * on Windows). Without this, a user who installed under a non-default prefix —
 * `npm i -g --prefix ~/opt`, or a shell that sets one per project — would get a
 * *second* copy written to the default prefix while the copy on their PATH
 * stayed old, which looks exactly like "ef update did nothing".
 *
 * Returns null when the path is not that shape, in which case we let npm pick.
 */
export function npmPrefixFor(dir: string): string | null {
    // dir is `<…>/node_modules/@scope/name` — two levels up clears the scope.
    const nodeModules = path.dirname(path.dirname(dir));
    if (path.basename(nodeModules) !== 'node_modules') return null;
    const parent = path.dirname(nodeModules);
    return path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
}

/**
 * Which manager owns a given install path.
 *
 * Each of these writes to a directory that carries its own name, so the path is
 * a more reliable signal than `npm_config_user_agent` (which is only set when a
 * process is spawned *by* a manager, and `ef` normally is not). npm is the
 * fallback because its global root — `<prefix>/lib/node_modules` — has no
 * distinguishing marker of its own.
 */
const MANAGER_MARKERS: Array<{ re: RegExp; manager: Manager }> = [
    { re: /[/\\]\.bun[/\\]/, manager: 'bun' },
    { re: /[/\\]\.?pnpm[/\\]/, manager: 'pnpm' },
    { re: /[/\\]\.?yarn[/\\]/, manager: 'yarn' },
];

function detectManager(dir: string): Manager {
    for (const { re, manager } of MANAGER_MARKERS) {
        if (re.test(dir)) return manager;
    }
    return 'npm';
}

type Install =
    | { kind: 'global'; dir: string; manager: Manager }
    | { kind: 'local'; dir: string; manager: Manager }
    | { kind: 'source'; dir: string };

/**
 * The package root of the CLI that is *currently running* — not whatever `ef`
 * resolves to on PATH. If a machine has both an npm and a pnpm global copy, the
 * one executing this code is the one the user means to update.
 *
 * This file runs from `out/commands/`, so the root is two levels up.
 */
function findPackageRoot(): string {
    let dir = path.resolve(__dirname, '..', '..');
    for (let i = 0; i < 4; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
            if (pkg.name === PKG) return dir;
        } catch { /* keep walking */ }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Nothing matched — fall back to the expected layout rather than throwing;
    // classifyInstall() still has to make a call, and a wrong guess surfaces as
    // a printed command the user can see, not a silent action.
    return path.resolve(__dirname, '..', '..');
}

/**
 * Is `dir` inside a `node_modules` belonging to the working directory or one of
 * its ancestors? That is what makes an install project-local rather than global.
 */
function isProjectLocal(dir: string): boolean {
    let ancestor = process.cwd();
    for (;;) {
        if (dir.startsWith(path.join(ancestor, 'node_modules') + path.sep)) return true;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
    }
}

export function classifyInstall(dir: string): Install {
    // A source checkout first, because it is the one case where the other
    // signals lie. `src/` and `tsconfig.json` are both excluded from the
    // published tarball by package.json's `files`, so finding them means this
    // is the repo — either run directly or symlinked in via `npm link`. (Node
    // resolves symlinks when loading modules, so a linked install reports the
    // checkout as its own location and lands here too.)
    if (fs.existsSync(path.join(dir, 'src')) && fs.existsSync(path.join(dir, 'tsconfig.json'))) {
        return { kind: 'source', dir };
    }
    const manager = detectManager(dir);
    if (isProjectLocal(dir)) return { kind: 'local', dir, manager };
    return { kind: 'global', dir, manager };
}

/** Windows ships these as `.cmd` shims, which `spawn` without a shell won't find bare. */
function binaryFor(manager: Manager): string {
    return process.platform === 'win32' ? `${manager}.cmd` : manager;
}

/**
 * Can we write to the directory the package lives in? A global npm install
 * under `/usr/local` or `/opt/homebrew` typically cannot, and npm's own EACCES
 * output buries the fix in a stack of permission dumps. Checking first lets us
 * say the useful sentence instead.
 */
function installDirWritable(dir: string): boolean {
    try {
        fs.accessSync(path.dirname(dir), fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/** The message for an install we refuse to touch — each names the right command. */
function refusalFor(install: Install, latest: string): string {
    if (install.kind === 'source') {
        return `This "ef" runs from a source checkout (${install.dir}), not an installed package.\n`
            + '  Update it with "git pull && npm install && npm run build" instead.';
    }
    const spec = `${PKG}@${latest}`;
    const cmds: Record<Manager, string> = {
        npm: `npm install ${spec}`,
        pnpm: `pnpm add ${spec}`,
        yarn: `yarn add ${spec}`,
        bun: `bun add ${spec}`,
    };
    return `This "ef" is installed inside a project (${install.dir}), not globally.\n`
        + `  Updating it here would desync that project's lockfile, so run "${cmds[install.manager]}"\n`
        + '  in the project yourself — or install the CLI globally to manage it with "ef update".';
}

interface UpdateOpts {
    check?: boolean;
    force?: boolean;
    json?: boolean;
}

export function registerUpdateCommand(program: Command): void {
    program
        .command('update')
        .description('Update the CLI to the latest published version, using whichever package manager installed it. "--check" only reports.')
        .addHelpText('after', `
Examples:
  $ ef update              Update to the latest release (no-op if current)
  $ ef update --check      Report whether an update exists; change nothing
  $ ef update --force      Reinstall the latest even if already on it
  $ ef update --check --json | jq -r .latest

Only global installs are updated. A project-local install or a source checkout
is reported with the command that is correct for it, and nothing is run.

Exit codes: 0 ok (including "--check" when an update exists), 2 not a global
install, 5 the registry could not be reached.`)
        .option('--check', 'Only report whether a newer version exists. Installs nothing.')
        .option('--force', 'Run the install even if the latest version is already the one running.')
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: UpdateOpts) => {
            const current = (() => {
                try { return (require('../../package.json') as { version: string }).version; } catch { return '0.0.0'; }
            })();

            let latest: string;
            try {
                latest = await fetchLatestVersion();
            } catch (err) {
                throw new CliError(
                    ExitCode.Network,
                    `Could not reach the npm registry to check for updates: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            const available = isNewer(latest, current);
            const install = classifyInstall(findPackageRoot());

            // Nothing to do — report and stop before any manager detection matters.
            if (!available && !opts.force) {
                // A version *ahead* of the registry means a local build or a
                // yanked release; saying "up to date" would be a small lie.
                const ahead = isNewer(current, latest);
                if (opts.json) {
                    log.json({ ok: true, current, latest, updateAvailable: false, updated: false, installKind: install.kind });
                } else if (ahead) {
                    log.info(`Running ${c.bold(current)}, which is ahead of the published ${c.bold(latest)}. Nothing to update.`);
                } else {
                    log.success(`Already on the latest version (${c.bold(current)}).`);
                }
                return;
            }

            if (opts.check) {
                if (opts.json) {
                    log.json({ ok: true, current, latest, updateAvailable: available, updated: false, installKind: install.kind });
                } else {
                    log.info(`${c.yellow('▲')} Update available ${c.dim(current)} → ${c.green(latest)}`);
                    log.detail(install.kind === 'global' ? '  Run "ef update" to install it.' : `  ${refusalFor(install, latest)}`);
                }
                return;
            }

            if (install.kind !== 'global') {
                throw new CliError(ExitCode.Validation, refusalFor(install, latest));
            }

            const spec = `${PKG}@${latest}`;
            const bin = binaryFor(install.manager);
            const args = INSTALL_ARGS[install.manager](spec);
            // Only npm takes a prefix this way; pnpm/yarn/bun own their global
            // root and resolve it themselves.
            const prefix = install.manager === 'npm' ? npmPrefixFor(install.dir) : null;
            if (prefix) args.push('--prefix', prefix);
            const printable = `${install.manager} ${args.join(' ')}`;

            if (!installDirWritable(install.dir)) {
                log.warn(`${install.dir} is not writable by this user — the install will likely fail with EACCES.`);
                log.detail(`  Re-run with sudo ("sudo ${printable}"), or switch to a per-user Node (nvm, fnm, volta) so global installs need no root.`);
            }

            log.info(`Updating ${c.bold(current)} → ${c.bold(latest)} with ${c.cyan(printable)}`);

            // stdio inherited so the manager's own progress and errors reach the
            // user directly — a spinner hiding a 20-second install reads as a hang.
            const res = spawnSync(bin, args, { stdio: 'inherit' });

            if (res.error) {
                const notFound = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
                throw new CliError(
                    ExitCode.Error,
                    notFound
                        ? `"${install.manager}" was not found on PATH, but this CLI appears to be installed by it (${install.dir}). Install it, or update by hand with: ${printable}`
                        : `Could not run "${printable}": ${res.error.message}`,
                );
            }
            if (res.status !== 0) {
                throw new CliError(
                    ExitCode.Error,
                    `"${printable}" exited with code ${res.status}. The output above should say why; you can also run it directly.`,
                );
            }

            log.success(`Updated to ${c.bold(latest)}. Run "ef --version" to confirm.`);
            // Says what happens next, because the alternative is a user
            // wondering whether to re-run `ef claude` / `ef cursor` by hand.
            // It cannot be done here: this process is still the OLD binary, so
            // stamping now would mark the old guidance current and suppress the
            // real refresh. The next command run by the new binary does it.
            log.detail('  CLAUDE.md / AGENTS.md / .cursor rules refresh themselves on your next "ef" command — nothing to re-run.');
            if (opts.json) log.json({ ok: true, current, latest, updateAvailable: available, updated: true, installKind: install.kind, command: printable });
        });
}
