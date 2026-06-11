import { Command } from 'commander';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';

export function registerWhoamiCommand(program: Command): void {
    program
        .command('whoami')
        .description('Print the active project root, brand, and key prefix.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const keyPrefix = rt.apiKey.length > 8 ? `${rt.apiKey.slice(0, 8)}…(${rt.apiKey.length} chars)` : '••••';
            if (opts.json) {
                log.json({
                    projectRoot: rt.projectRoot,
                    brandId: rt.config.brandId,
                    apiUrl: rt.config.apiUrl,
                    syncRoot: rt.config.syncRoot,
                    syncLayout: rt.config.syncLayout,
                    saveMode: rt.config.saveMode,
                    apiKeyPrefix: keyPrefix,
                    brandRoot: rt.brandRoot,
                });
                return;
            }
            log.info(`${c.bold('Project')}    ${rt.projectRoot}`);
            log.info(`${c.bold('Brand id')}   ${rt.config.brandId}`);
            log.info(`${c.bold('API URL')}    ${rt.config.apiUrl}`);
            log.info(`${c.bold('Sync layout')} ${rt.config.syncLayout}`);
            log.info(`${c.bold('Files root')} ${rt.brandRoot}`);
            log.info(`${c.bold('Save mode')}  ${rt.config.saveMode}`);
            log.info(`${c.bold('API key')}    ${keyPrefix}`);
        });
}
