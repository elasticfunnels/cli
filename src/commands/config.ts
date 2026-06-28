import { Command } from 'commander';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { EfConfig, findProjectRoot, loadConfig, saveConfig } from '../utils/store';

/** Keys a user may change with `ef config set`. brandId/auth go through `ef init`. */
const SETTABLE = ['saveMode', 'apiUrl', 'syncRoot', 'syncLayout'] as const;
type Settable = (typeof SETTABLE)[number];

function requireRoot(): string {
    const root = findProjectRoot();
    if (!root) {
        throw new CliError(ExitCode.Auth, 'No ElasticFunnels project found here or in any parent. Run "ef init" first.');
    }
    return root;
}

export function registerConfigCommand(program: Command): void {
    const cmd = program
        .command('config')
        .description('View or change project config in .ef/config.json (saveMode, apiUrl, syncRoot, syncLayout).');

    cmd.command('get [key]')
        .description('Print the whole config, or just one key.')
        .option('--json', 'Print as JSON.')
        .action(async (key: string | undefined, opts: { json?: boolean }) => {
            const cfg = await loadConfig(requireRoot());
            if (key) {
                if (!(key in cfg)) throw new CliError(ExitCode.Validation, `Unknown config key "${key}".`);
                const value = (cfg as unknown as Record<string, unknown>)[key];
                if (opts.json) { log.json({ [key]: value }); return; }
                process.stdout.write(`${value ?? ''}\n`); // stdout so it's pipeable
                return;
            }
            if (opts.json) { log.json(cfg); return; }
            for (const [k, v] of Object.entries(cfg)) process.stdout.write(`${k}=${v ?? ''}\n`);
        });

    cmd.command('set <key> <value>')
        .description(`Change a config key. Settable: ${SETTABLE.join(', ')}.`)
        .option('--json', 'Print the updated config as JSON.')
        .action(async (key: string, value: string, opts: { json?: boolean }) => {
            const root = requireRoot();
            if (!SETTABLE.includes(key as Settable)) {
                throw new CliError(
                    ExitCode.Validation,
                    `Cannot set "${key}". Settable keys: ${SETTABLE.join(', ')}. (Change the brand or key with "ef init".)`,
                );
            }
            const cfg = await loadConfig(root);
            const next: EfConfig = { ...cfg };
            const v = value.trim();
            switch (key as Settable) {
                case 'saveMode':
                    if (v !== 'draft' && v !== 'direct') throw new CliError(ExitCode.Validation, 'saveMode must be "draft" or "direct".');
                    next.saveMode = v;
                    break;
                case 'syncLayout':
                    if (v !== 'flat' && v !== 'nested') throw new CliError(ExitCode.Validation, 'syncLayout must be "flat" or "nested".');
                    next.syncLayout = v;
                    log.warn('Changed syncLayout — files already on disk are NOT moved. Re-pull into a fresh folder if the layout must match.');
                    break;
                case 'apiUrl':
                    if (!/^https?:\/\//.test(v)) throw new CliError(ExitCode.Validation, 'apiUrl must start with http:// or https://.');
                    next.apiUrl = v;
                    break;
                case 'syncRoot':
                    if (!v || v.includes('/') || v.includes('\\') || v.startsWith('.')) {
                        throw new CliError(ExitCode.Validation, 'syncRoot must be a simple folder name (no slashes).');
                    }
                    next.syncRoot = v;
                    log.warn('Changed syncRoot — files already on disk are NOT moved.');
                    break;
            }
            await saveConfig(root, next);
            if (opts.json) { log.json({ ok: true, config: next }); return; }
            log.success(`Set ${key} = ${v}.`);
        });
}
