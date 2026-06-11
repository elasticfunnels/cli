import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { writeFileAtomic } from '../utils/fs';

export function registerVariablesCommand(program: Command): void {
    const cmd = program
        .command('variables')
        .description('Read or write the brand-level variables JSON.');

    cmd.command('get')
        .description('Print the brand variables as JSON.')
        .action(async () => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const vars = await api.getBrandVariables(rt.config.brandId);
            log.json(vars);
        });

    cmd.command('pull')
        .description(`Pull the variables JSON to <syncRoot>/<brandId>/variables.json on disk.`)
        .action(async () => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const vars = await api.getBrandVariables(rt.config.brandId);
            const out = path.join(rt.brandRoot, 'variables.json');
            await writeFileAtomic(out, JSON.stringify(vars, null, 2) + '\n');
            log.success(`Wrote ${out}`);
        });

    cmd.command('push')
        .description('Push <syncRoot>/<brandId>/variables.json (or --file) to the server.')
        .option('--file <path>', 'Read variables JSON from this path instead of the default.')
        .action(async (opts: { file?: string }) => {
            const rt = await loadRuntime();
            const file = opts.file ? path.resolve(opts.file) : path.join(rt.brandRoot, 'variables.json');
            let raw: string;
            try {
                raw = await fs.promises.readFile(file, 'utf8');
            } catch {
                throw new CliError(ExitCode.NotFound, `Variables file not found: ${file}. Run "ef variables pull" or pass --file <path>.`);
            }
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch (err) {
                throw new CliError(ExitCode.Validation, `Variables file is not valid JSON: ${(err as Error).message}`);
            }
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            await api.setBrandVariables(rt.config.brandId, parsed);
            log.success(`Pushed ${Object.keys(parsed).length} variables.`);
        });
}
