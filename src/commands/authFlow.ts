import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { confirm } from '../utils/prompt';
import { loader } from '../utils/loader';
import { EfRuntime, saveApiKey } from '../utils/store';
import {
    DeviceToken,
    openBrowser,
    pollForDeviceToken,
    redeemPairingCode,
    startDeviceAuthorization,
} from '../api/deviceAuth';

/**
 * The sign-in flow, shared by `ef init` (first bind) and `ef login` (re-auth).
 *
 * Keeping one copy matters because the security properties live in the details
 * — printing only the short user code, opening a browser only when there is
 * one, refusing the flow when nobody can approve it. A second implementation
 * would drift from those.
 */

export interface SignInOpts {
    /** Machine-readable run: print no prose and never open a browser. */
    json?: boolean;
    /** Fail rather than prompt. */
    nonInteractive?: boolean;
}

/**
 * Browser sign-in.
 *
 * Prints the short user code and the link, opens a browser if there is one, and
 * waits. The code on screen is deliberately harmless — it cannot collect a
 * token without the device code this process is holding — so it is safe to
 * leave in a scrollback buffer or read out over a call.
 */
export async function runDeviceSignIn(apiUrl: string, opts: SignInOpts, headline?: string): Promise<DeviceToken> {
    const authorization = await startDeviceAuthorization(apiUrl);

    if (!opts.json) {
        log.info('');
        log.info(`  ${headline ?? 'Sign in to ElasticFunnels to connect this folder.'}`);
        log.info('');
        log.info(`  Your code:  ${c.bold(authorization.userCode)}`);
        log.info(`  Open:       ${c.cyan(authorization.verificationUriComplete)}`);
        log.info('');
        log.detail('  Approve it in your browser and this will continue on its own.');
        log.info('');
    }

    // Only reach for a browser on an interactive run. In CI or a pipe there is
    // nothing to open, and spawning a GUI process would be surprising.
    if (!opts.json && !opts.nonInteractive && process.stdout.isTTY === true) {
        openBrowser(authorization.verificationUriComplete);
    }

    const ld = opts.json ? null : loader('Waiting for approval');
    try {
        const token = await pollForDeviceToken(apiUrl, authorization, {
            onTick: (seconds) => ld?.update(`Waiting for approval (${seconds}s)`),
        });
        ld?.stop();
        log.success(`Signed in to ${token.brandName || `brand #${token.brandId}`}.`);
        return token;
    } catch (err) {
        ld?.stop();
        throw err;
    }
}

/**
 * Is there a human here who could approve a sign-in right now?
 *
 * Both halves matter. `--json` and a non-TTY stdin mean a script or the
 * SessionStart hook is driving, and a prompt there does not wait for a person
 * — it hangs the caller until something times out. CI is the same case with a
 * friendlier name.
 */
export function canPromptForReauth(opts: SignInOpts): boolean {
    if (opts.json || opts.nonInteractive) return false;
    if (process.env.CI) return false;
    return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/**
 * Replace the credential for an already-bound folder, in place.
 *
 * Only `.ef/auth` is rewritten: the brand binding, sync layout, save mode and
 * every synced file stay exactly as they were. That is the whole point — the
 * alternative (`ef reset && ef init`) throws away a working project setup to
 * fix an expired token.
 *
 * The new token must be for the brand this folder is already bound to. The
 * device flow lets the approver pick a brand, so a mismatch is a real
 * possibility, and silently accepting it would leave a folder whose config says
 * one brand and whose credential opens another.
 */
export async function reauthenticate(
    rt: EfRuntime,
    opts: SignInOpts & { code?: string; apiKey?: string } = {},
): Promise<EfRuntime> {
    const apiUrl = rt.config.apiUrl;
    let token: DeviceToken | null = null;
    let apiKey: string;

    if (opts.apiKey) {
        apiKey = opts.apiKey.trim();
    } else if (opts.code) {
        token = await redeemPairingCode(apiUrl, opts.code);
        apiKey = token.accessToken;
        log.success(`Paired with ${token.brandName || `brand #${token.brandId}`}.`);
    } else {
        token = await runDeviceSignIn(apiUrl, opts, `Sign in again to reconnect this folder to brand #${rt.config.brandId}.`);
        apiKey = token.accessToken;
    }

    if (!apiKey) throw new CliError(ExitCode.Validation, 'No credential was obtained.');

    if (token && token.brandId !== rt.config.brandId) {
        throw new CliError(
            ExitCode.Validation,
            `You approved ${token.brandName || `brand #${token.brandId}`}, but this folder is bound to brand #${rt.config.brandId}. `
            + 'Nothing was changed. Approve the matching brand, or run "ef reset" and "ef init" to bind this folder to a different one.',
        );
    }

    await saveApiKey(rt.projectRoot, apiKey);
    return { ...rt, apiKey };
}

/**
 * Run `fn`; if it fails because the credential was rejected, offer to sign in
 * again and run it once more.
 *
 * The retry is deliberately one-shot and only on an interactive terminal. A
 * loop would spin against a genuinely broken credential, and prompting from a
 * script or the SessionStart hook would hang the thing that invoked us — those
 * get the error and the hint instead.
 */
export async function withReauth<T>(
    rt: EfRuntime,
    opts: SignInOpts,
    fn: (rt: EfRuntime) => Promise<T>,
): Promise<T> {
    try {
        return await fn(rt);
    } catch (err) {
        if (!(err instanceof CliError) || err.code !== ExitCode.Auth) throw err;
        if (!canPromptForReauth(opts)) throw err;

        log.error(err.message);
        if (!(await confirm('Sign in again now?', true))) throw err;

        const fresh = await reauthenticate(rt, opts);
        return await fn(fresh);
    }
}
