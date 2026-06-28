import { Command } from 'commander';
import { CliError, ExitCode } from './utils/exit';
import { log } from './utils/log';
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
import { registerClaudeCommand } from './commands/claude';
import { registerInstallHighlighterCommand } from './commands/installHighlighter';
import { registerConfigCommand } from './commands/config';

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
  • Exit codes are stable: 0=ok 2=usage 3=auth 4=conflict 5=network 6=server.
  • No global state. cd into a different project, get a different brand.`)
        .version(getVersion(), '-v, --version', 'Print the CLI version.')
        .helpOption('-h, --help', 'Show help for a command.')
        .showHelpAfterError('(use "ef <cmd> --help" for command details)');

    // Register every command. Each registrar attaches subcommands and options.
    registerInitCommand(program);
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
    registerInstallHighlighterCommand(program);
    registerConfigCommand(program);

    return program;
}

/** Programmatic entry — exported and called from `bin/ef.js`. */
export async function run(argv: string[]): Promise<void> {
    const program = buildProgram();
    try {
        await program.parseAsync(argv);
    } catch (err) {
        if (err instanceof CliError) {
            log.error(err.message);
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
