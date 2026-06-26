import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';

/**
 * Editors that understand `--install-extension`. They're all VS Code under the
 * hood, so the same `.vsix` and the same flag work everywhere — only the binary
 * name on PATH differs. Probed in this order; `--editor` overrides.
 */
const EDITORS: Array<{ cli: string; name: string }> = [
    { cli: 'cursor', name: 'Cursor' },
    { cli: 'code', name: 'VS Code' },
    { cli: 'code-insiders', name: 'VS Code Insiders' },
    { cli: 'codium', name: 'VSCodium' },
];

interface InstallOptions {
    editor?: string;
    extensionsDir?: string;
    json?: boolean;
}

/** Is this editor's CLI on PATH? `<cli> --version` exits 0 when it is. */
function editorAvailable(cli: string): boolean {
    try {
        const r = spawnSync(cli, ['--version'], { stdio: 'ignore' });
        return !r.error && r.status === 0;
    } catch {
        return false;
    }
}

/**
 * Locate the bundled `ef-syntax-*.vsix`. It ships under `assets/` at the package
 * root; this file runs from `out/commands/`, so the root is two levels up. The
 * extra candidates keep `npm link` / ts-node layouts working in dev.
 */
function findVsix(): string | null {
    const roots = [
        path.resolve(__dirname, '..', '..', 'assets'),
        path.resolve(__dirname, '..', '..', '..', 'assets'),
    ];
    for (const dir of roots) {
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        // Prefer the highest version if several are present.
        const vsix = names.filter((n) => /^ef-syntax-.*\.vsix$/.test(n)).sort().pop();
        if (vsix) return path.join(dir, vsix);
    }
    return null;
}

export function registerInstallHighlighterCommand(program: Command): void {
    program
        .command('install-highlighter')
        .description('Install the ElasticFunnels syntax-highlighting extension into your editor (Cursor / VS Code / VSCodium) so .ef files are highlighted.')
        .option('--editor <cli>', 'Install into a specific editor only (cursor, code, code-insiders, codium).')
        .option('--extensions-dir <dir>', 'Install into a custom extensions directory (passed through to the editor; mainly for testing).')
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: InstallOptions) => {
            const vsix = findVsix();
            if (!vsix) {
                throw new CliError(
                    ExitCode.NotFound,
                    'Bundled extension (ef-syntax-*.vsix) not found. If you are running from a source checkout, build it first with "npm run build:ext".',
                );
            }

            // Resolve which editors to target.
            let targets = EDITORS;
            if (opts.editor) {
                const wanted = opts.editor.trim().toLowerCase();
                const match = EDITORS.find((e) => e.cli === wanted);
                if (!match) {
                    throw new CliError(ExitCode.Validation, `Unknown --editor "${opts.editor}". Expected one of: ${EDITORS.map((e) => e.cli).join(', ')}.`);
                }
                targets = [match];
            }

            const available = targets.filter((e) => editorAvailable(e.cli));
            if (available.length === 0) {
                const hint = opts.editor
                    ? `"${opts.editor}" isn't on your PATH.`
                    : 'No supported editor CLI found on your PATH.';
                log.warn(`${hint}`);
                log.detail('For VS Code, run the "Shell Command: Install \'code\' command in PATH" command once, then re-run this.');
                log.detail('Meanwhile, `ef init` already maps *.ef → handlebars in .vscode/settings.json so files still highlight as HTML.');
                if (opts.json) log.json({ ok: false, reason: 'no-editor-cli', installed: [] });
                throw new CliError(ExitCode.NotFound, 'No editor CLI available to install the extension.');
            }

            const installed: Array<{ editor: string; cli: string }> = [];
            const failed: Array<{ editor: string; cli: string; code: number | null }> = [];
            for (const e of available) {
                const args = ['--install-extension', vsix, '--force'];
                if (opts.extensionsDir) args.push('--extensions-dir', opts.extensionsDir);
                log.info(`Installing into ${e.name} (${e.cli})…`);
                const r = spawnSync(e.cli, args, { stdio: opts.json ? 'ignore' : 'inherit' });
                if (!r.error && r.status === 0) {
                    installed.push({ editor: e.name, cli: e.cli });
                } else {
                    failed.push({ editor: e.name, cli: e.cli, code: r.status });
                }
            }

            if (installed.length > 0) {
                log.success(`Installed ElasticFunnels syntax highlighting into: ${installed.map((i) => i.editor).join(', ')}.`);
                log.detail('Reload the editor window (or reopen a .ef file) to see highlighting.');
            }
            for (const f of failed) {
                log.warn(`Failed to install into ${f.editor} (${f.cli}) — exit ${f.code ?? 'unknown'}.`);
            }

            if (opts.json) {
                log.json({ ok: installed.length > 0, vsix, installed, failed });
            }
            if (installed.length === 0) {
                throw new CliError(ExitCode.Error, 'Could not install the extension into any editor.');
            }
        });
}
