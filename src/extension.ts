import { Command } from 'commander';
import { CliError, ExitCode } from './utils/exit';
import { log } from './utils/log';
import { getUpdateNotice } from './utils/updateNotifier';
import { refreshGuidanceIfStale } from './commands/claude';
import { findProjectRoot } from './utils/store';
import { registerInitCommand } from './commands/init';
import { registerResetCommand } from './commands/reset';
import { registerWhoamiCommand } from './commands/whoami';
import { registerStatusCommand } from './commands/status';
import { registerListCommand } from './commands/list';
import { registerGetCommand } from './commands/get';
import { registerPullCommand } from './commands/pull';
import { registerPushCommand } from './commands/push';
import { registerPagesCommand } from './commands/pageCommands';
import { registerComponentsCommand } from './commands/componentCommands';
import { registerProductsCommand } from './commands/productCommands';
import { registerPreviewCommand } from './commands/preview';
import { registerScriptsCommand } from './commands/scripts';
import { registerAssetsCommand } from './commands/assets';
import { registerVariablesCommand } from './commands/variables';
import { registerDiffCommand } from './commands/diff';
import { registerAskCommand } from './commands/ask';
import { registerClaudeCommand, registerCodexCommand, registerCursorCommand } from './commands/claude';
import { registerMcpCommand } from './commands/mcp';
import { registerInstallHighlighterCommand } from './commands/installHighlighter';
import { registerUpdateCommand } from './commands/update';
import { registerLoginCommand } from './commands/login';
import { registerCollectionsCommand } from './commands/collections';
import { augmentAuthError } from './utils/credential';
import { registerConfigCommand } from './commands/config';
import { registerSeoCommand } from './commands/seo';
import { registerStatsCommand } from './commands/stats';
import { registerWatchCommand } from './commands/watch';
import { registerLintCommand } from './commands/lint';
import { registerDomainsCommand } from './commands/domains';
import { registerCrmCommand } from './commands/crm';
import { registerFunnelsCommand } from './commands/funnels';
// Temporarily DISABLED — kept in the tree but not wired up. Emails need a raw
// code-editor path (not just the GrapesJS builder) and automations need real
// graph UX before they're safe to ship; re-enable by restoring these two lines
// and their register…() calls below.
// import { registerAutomationsCommand } from './commands/automations';
// import { registerEmailsCommand } from './commands/emails';

function getVersion(): string {
    try {
        return require('../package.json').version as string;
    } catch {
        return '0.0.0';
    }
}

function buildProgram(): Command {
    const program = new Command();
    program
        .name('ef')
        .description(`ElasticFunnels CLI — folder-scoped, scriptable.

The CLI binds each project folder to one ElasticFunnels brand. Run "ef init"
inside the folder you want to use; it'll write a .ef/ directory with your
config and API key. Every other command finds that folder by walking up from
the current directory (Git-style).

Designed for Claude Code, scripts, and humans equally:
  • All commands accept --json for machine-readable output.
  • Exit codes are stable: 0=ok 2=usage 3=auth 4=conflict 5=network 6=server
    7=notfound 130=interrupted.
  • No global state. cd into a different project, get a different brand.`)
        .version(getVersion(), '-v, --version', 'Print the CLI version.')
        .helpOption('-h, --help', 'Show help for a command.')
        .showHelpAfterError('(use "ef <cmd> --help" for command details)');

    // Register every command. Each registrar attaches subcommands and options.
    registerInitCommand(program);
    registerLoginCommand(program);
    registerResetCommand(program);
    registerWhoamiCommand(program);
    registerStatusCommand(program);
    registerListCommand(program);
    registerPreviewCommand(program);
    registerGetCommand(program);
    registerPullCommand(program);
    registerPushCommand(program);
    registerPagesCommand(program);
    registerComponentsCommand(program);
    registerProductsCommand(program);
    registerScriptsCommand(program);
    registerAssetsCommand(program);
    registerVariablesCommand(program);
    registerDiffCommand(program);
    registerAskCommand(program);
    registerClaudeCommand(program);
    registerCodexCommand(program);
    registerCursorCommand(program);
    registerMcpCommand(program);
    registerInstallHighlighterCommand(program);
    registerUpdateCommand(program);
    registerConfigCommand(program);
    registerWatchCommand(program);
    registerLintCommand(program);
    registerDomainsCommand(program);
    registerSeoCommand(program);
    registerStatsCommand(program);
    registerCollectionsCommand(program);
    registerCrmCommand(program);
    registerFunnelsCommand(program);
    // Disabled for now (see the commented imports above):
    // registerAutomationsCommand(program);
    // registerEmailsCommand(program);

    return program;
}

/**
 * Re-stamp stale guidance, never at the cost of the command that just ran.
 *
 * Everything here is best-effort: a read-only checkout, a project that opted
 * out, or no project at all must not turn a successful command into a failure.
 */
async function refreshGuidanceQuietly(): Promise<void> {
    try {
        const root = findProjectRoot();
        if (!root) return;
        const refreshed = await refreshGuidanceIfStale(root);
        if (refreshed.length > 0) {
            log.detail(`Refreshed ${refreshed.join(', ')} for CLI v${getVersion()}.`);
        }
    } catch { /* never fail a command over guidance upkeep */ }
}

/** Programmatic entry — exported and called from `bin/ef.js`. */
export async function run(argv: string[]): Promise<void> {
    const program = buildProgram();

    // "Update available" nudge for global installs. Reads a daily cache and
    // prints on exit (so it survives process.exit()); a background refresh keeps
    // the cache fresh without ever delaying the command. Silent in scripts/CI/pipes.
    const notice = getUpdateNotice(getVersion(), argv);
    if (notice) process.once('exit', () => { try { process.stderr.write(notice); } catch { /* ignore */ } });

    try {
        await program.parseAsync(argv);
        // Bring the project's AI guidance up to this CLI's version, whatever
        // command just ran.
        //
        // It cannot happen during `ef update`: that process IS the old binary,
        // so stamping there would write the old guidance and mark it current —
        // worse than leaving it stale, because the real refresh would then be
        // skipped. The next command run by the new binary is the first honest
        // moment, and this is it.
        //
        // Previously only `ef pull` did this, which covered Claude Code (its
        // SessionStart hook pulls) but left Cursor and Codex users reading
        // guidance for whatever version they last pulled on. Costs three small
        // reads when current, and writes nothing unless a managed block is
        // actually out of date.
        await refreshGuidanceQuietly();
    } catch (err) {
        if (err instanceof CliError) {
            // A rejected credential gets the fix appended here, once, based on
            // which kind is actually stored — so every endpoint's 401 says the
            // same true thing. See utils/credential.ts.
            log.error(augmentAuthError(err).message);
            process.exit(err.code);
        }
        // commander throws CommanderError for invalid usage — those are
        // already formatted by commander itself, surface them with code 2.
        const anyErr = err as { code?: string; exitCode?: number; message?: string };
        if (anyErr && anyErr.code && anyErr.code.startsWith('commander.')) {
            // `commander.help` etc. — already printed by commander.
            process.exit(typeof anyErr.exitCode === 'number' ? anyErr.exitCode : ExitCode.Validation);
        }
        log.error((err instanceof Error ? err.message : String(err)));
        process.exit(ExitCode.Error);
    }
}
