import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { credentialKind } from '../utils/credential';
import { loadRuntime } from '../utils/store';
import { canPromptForReauth, reauthenticate } from './authFlow';

/**
 * `ef login` — replace this folder's credential without touching anything else.
 *
 * The gap it fills: a revoked device or a regenerated key used to mean
 * `ef reset && ef init`, which deletes the brand binding, sync layout and save
 * mode, then re-pulls the whole tree — a full re-setup to fix one expired
 * string. This rewrites `.ef/auth` and stops.
 */

interface LoginOpts {
    code?: string;
    apiKey?: string;
    nonInteractive?: boolean;
    json?: boolean;
}

export function registerLoginCommand(program: Command): void {
    const run = async (opts: LoginOpts): Promise<void> => {
        // loadRuntime needs a readable .ef/auth, and the common reason to run
        // this command is that the credential is bad — not missing — so it
        // normally loads fine. A folder with no project at all gets the usual
        // "run ef init" error from here.
        const rt = await loadRuntime();

        if (!opts.apiKey && !opts.code && !canPromptForReauth(opts)) {
            throw new CliError(
                ExitCode.Validation,
                'Browser sign-in needs an interactive terminal. Pass --code <pairing-code> (Settings → AI tools → advanced) or --api-key <key> for an unattended run.',
            );
        }

        const fresh = await reauthenticate(rt, opts);

        // Prove the new credential actually works before claiming success —
        // otherwise the next command fails with the same 401 and it looks like
        // the login silently did nothing.
        const api = new ApiClient(fresh.config.apiUrl, fresh.apiKey);
        const ok = await api.ping(fresh.config.brandId).catch(() => false);
        if (!ok) {
            throw new CliError(
                ExitCode.Auth,
                `Signed in, but the new credential still cannot reach brand #${fresh.config.brandId}. It was saved anyway — check that the brand still exists and that your account has access to it.`,
            );
        }

        if (opts.json) {
            log.json({
                ok: true,
                projectRoot: fresh.projectRoot,
                brandId: fresh.config.brandId,
                apiUrl: fresh.config.apiUrl,
                credential: credentialKind(fresh.apiKey),
            });
            return;
        }
        log.success(`Reconnected to brand #${fresh.config.brandId}. Credential updated in ${c.dim('.ef/auth')}.`);
        log.detail('Nothing else changed — your synced files and settings are as they were.');
    };

    const describe = (cmd: Command): Command => cmd
        .option('--code <code>', 'Redeem a one-time pairing code instead of using a browser (Settings → AI tools → advanced).')
        .option('--api-key <key>', 'Use a long-lived brand API key instead of signing in.')
        .option('--non-interactive', 'Fail rather than prompt.')
        .option('--json', 'Print the result as JSON.')
        .action(run);

    describe(
        program
            .command('login')
            .description('Sign in again for this folder, replacing the stored credential. Keeps the brand binding, settings and every synced file.')
            .addHelpText('after', `
Examples:
  $ ef login                       Browser sign-in (default)
  $ ef login --code ABCD-1234      Headless machine, one-time pairing code
  $ ef login --api-key <key>       Unattended / CI

Use this after disconnecting a device under Settings → Connected devices, or
when a brand API key has been regenerated. The new credential must be for the
brand this folder is already bound to; to switch brands, use "ef reset".`),
    );

    // `ef auth` reads more naturally to some, and "login" is what others reach
    // for first. Both are cheap to keep.
    describe(
        program
            .command('auth')
            .description('Alias for "ef login".'),
    );
}
