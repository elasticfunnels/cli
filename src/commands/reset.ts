import { Command } from 'commander';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { clearLogin, findProjectRoot } from '../utils/store';

export function registerResetCommand(program: Command): void {
    program
        .command('reset')
        .description('Unbind this folder: remove .ef/config.json and .ef/auth. Does not touch synced files on disk.')
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const root = findProjectRoot();
            if (!root) {
                throw new CliError(ExitCode.Auth, 'No ElasticFunnels project found in this folder or any parent.');
            }
            await clearLogin(root);
            log.success(`Reset. Removed .ef/ in ${root}.`);
            if (opts.json) log.json({ ok: true, projectRoot: root });
        });
}
