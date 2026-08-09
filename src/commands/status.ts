import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { c, log } from '../utils/log';
import { loader } from '../utils/loader';
import { loadRuntime } from '../utils/store';
import { SyncStateFile, STATE_VERSION } from '../sync/stateFile';
import { CliError, ExitCode } from '../utils/exit';
import { credentialKind, reauthHint } from '../utils/credential';

export function registerStatusCommand(program: Command): void {
    program
        .command('status')
        .description('Show config, connection health, last sync timestamp, and entity counts.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);

            let connected = false;
            let connectError: string | null = null;
            // Distinct from "unreachable": the server answered, it just won't
            // accept this credential. Different cause, different fix.
            let credentialRejected = false;
            const counts = { pages: 0, components: 0, scripts: 0, assets: 0 };

            const spin = opts.json ? null : loader('Checking connection');
            try {
                try {
                    const ping = await api.pingDetailed(rt.config.brandId);
                    connected = ping.ok;
                    if (!ping.ok && (ping.status === 401 || ping.status === 403)) {
                        credentialRejected = true;
                        connectError = `Credential rejected (HTTP ${ping.status}). ${reauthHint(credentialKind(rt.apiKey))}`;
                    } else if (!ping.ok) {
                        connectError = `Server responded HTTP ${ping.status}.`;
                    }
                } catch (err) {
                    connectError = err instanceof Error ? err.message : String(err);
                    if (err instanceof CliError && err.code === ExitCode.Auth) {
                        credentialRejected = true;
                        connectError = `${err.message} ${reauthHint(credentialKind(rt.apiKey))}`;
                    }
                }

                if (connected) {
                    const [pages, components, scripts, assets] = await Promise.all([
                        api.listPages(rt.config.brandId).catch(() => []),
                        api.listComponents(rt.config.brandId).catch(() => []),
                        api.listBackendScripts(rt.config.brandId).catch(() => []),
                        api.listAssets(rt.config.brandId).catch(() => []),
                    ]);
                    counts.pages = pages.length;
                    counts.components = components.length;
                    counts.scripts = scripts.length;
                    counts.assets = assets.length;
                }
            } finally {
                spin?.stop();
            }

            const state = await SyncStateFile.load(rt.brandRoot, rt.config.brandId);
            const stateTooNew = state.isVersionTooNew();

            if (opts.json) {
                log.json({
                    projectRoot: rt.projectRoot,
                    apiUrl: rt.config.apiUrl,
                    brandId: rt.config.brandId,
                    saveMode: rt.config.saveMode,
                    syncRoot: rt.config.syncRoot,
                    connected,
                    connectError,
                    credentialRejected,
                    credential: credentialKind(rt.apiKey),
                    lastPulledAt: rt.config.lastPulledAt ?? null,
                    lastPagesSyncAt: state.lastPagesSyncAt,
                    lastAssetsSyncAt: state.lastAssetsSyncAt,
                    counts,
                    state: {
                        path: state.statePath,
                        loadedVersion: state.getLoadedVersion(),
                        cliVersion: STATE_VERSION,
                        tooNew: stateTooNew,
                    },
                });
                return;
            }

            log.info(`${c.bold('Project')}     ${rt.projectRoot}`);
            log.info(`${c.bold('Brand')}       ${rt.config.brandId}`);
            const health = connected
                ? c.green('(reachable)')
                : credentialRejected ? c.red('(reachable — credential rejected)') : c.red('(unreachable)');
            log.info(`${c.bold('API')}         ${rt.config.apiUrl} ${health}`);
            if (!connected && connectError) log.detail(connectError);
            log.info(`${c.bold('Save mode')}   ${rt.config.saveMode}`);
            log.info(`${c.bold('Last pull')}   ${rt.config.lastPulledAt ?? 'never'}`);
            log.info(`${c.bold('Pages')}       ${counts.pages}`);
            log.info(`${c.bold('Components')}  ${counts.components}`);
            log.info(`${c.bold('Scripts')}     ${counts.scripts}`);
            log.info(`${c.bold('Assets')}      ${counts.assets}`);
            if (stateTooNew) {
                log.warn(`State file is schema v${state.getLoadedVersion()} but this CLI is v${STATE_VERSION}. Sync will run but local state will not be updated. Run "ef update".`);
            }
            // A health check that reports a dead credential and still exits 0 is
            // how the problem stays hidden from whatever is scripting it.
            if (credentialRejected) process.exitCode = ExitCode.Auth;
        });
}
