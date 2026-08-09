import axios from 'axios';
import { CliError, ExitCode } from '../utils/exit';

/**
 * Device authorization (RFC 8628 shape) against the ElasticFunnels app.
 *
 * Separate from `ApiClient` because this is the one flow that runs BEFORE the
 * CLI has any credential — there is no `EF-Access-Key` to send yet, which is
 * the entire point.
 *
 * How it fits together:
 *
 *   1. {@link startDeviceAuthorization} returns a secret `deviceCode` we keep
 *      and a short `userCode` we show. The user code is safe to print, read
 *      aloud, or paste into chat: on its own it cannot collect a token.
 *   2. The user approves in a browser session that is already signed in.
 *   3. {@link pollForDeviceToken} exchanges the device code for the token.
 *
 * The user therefore never copies a credential, and nothing secret lands in
 * shell history or a scrollback buffer.
 */

export interface DeviceAuthorization {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    /** Seconds until the request expires (server-side). */
    expiresIn: number;
    /** Seconds the server wants between polls. */
    interval: number;
}

export interface DeviceToken {
    accessToken: string;
    brandId: number;
    brandName?: string | null;
    expiresAt?: string | null;
}

function client(apiUrl: string) {
    return axios.create({
        baseURL: apiUrl.replace(/\/$/, ''),
        timeout: 30000,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': `ef-cli/${cliVersion()}`,
        },
        // Read the status ourselves: `authorization_pending` arrives as a 428
        // and is a completely normal part of the flow, not an error.
        validateStatus: (s) => s >= 200 && s < 600,
    });
}

function cliVersion(): string {
    try {
        return require('../../package.json').version as string;
    } catch {
        return '0.0.0';
    }
}

/** A human-recognisable name for this machine, shown on the approval screen. */
export function deviceName(): string {
    try {
        // Lazy require: `os` is always present, but keeping it here documents
        // that the hostname is only ever used as a display label.
        const os = require('os') as typeof import('os');
        const host = os.hostname().replace(/\.local$/, '');
        return host || 'Unknown device';
    } catch {
        return 'Unknown device';
    }
}

/** Ask the server to start an authorization request. */
export async function startDeviceAuthorization(apiUrl: string): Promise<DeviceAuthorization> {
    let res;
    try {
        res = await client(apiUrl).post('/api/cli/device/authorize', {
            client: 'ef-cli',
            device_name: deviceName(),
            client_version: cliVersion(),
        });
    } catch (e) {
        throw new CliError(ExitCode.Network, `Could not reach ${apiUrl}. Check your connection and --api-url.`);
    }

    if (res.status === 404) {
        // An older server predates the device flow. Say so precisely: the fix
        // is a key, not a retry.
        throw new CliError(
            ExitCode.Server,
            'This ElasticFunnels server does not support browser sign-in yet. Use "ef init --api-key <key>" instead (Settings → All Settings → API).',
        );
    }
    if (res.status >= 400) {
        throw new CliError(ExitCode.Server, `Could not start sign-in (HTTP ${res.status}).`);
    }

    const body = res.data ?? {};
    if (!body.device_code || !body.user_code) {
        throw new CliError(ExitCode.Server, 'Sign-in response from the server was missing a code.');
    }

    return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        verificationUriComplete: body.verification_uri_complete || body.verification_uri,
        expiresIn: Number(body.expires_in) || 600,
        interval: Number(body.interval) || 5,
    };
}

export interface PollOptions {
    /** Called once per poll so the caller can animate or print progress. */
    onTick?: (secondsWaited: number) => void;
    /** Overrides the server's interval. Only used by tests. */
    intervalSeconds?: number;
    /** Hard stop, independent of the server's expiry. */
    timeoutSeconds?: number;
}

/**
 * Poll until the user approves, denies, or the request expires.
 *
 * Honours `slow_down` by widening the interval, as the RFC requires — the
 * server returns it when we poll faster than we were told to.
 */
export async function pollForDeviceToken(
    apiUrl: string,
    authorization: DeviceAuthorization,
    opts: PollOptions = {},
): Promise<DeviceToken> {
    const http = client(apiUrl);
    let interval = opts.intervalSeconds ?? authorization.interval;
    const deadline = Date.now() + (opts.timeoutSeconds ?? authorization.expiresIn) * 1000;
    const startedAt = Date.now();

    for (;;) {
        if (Date.now() >= deadline) {
            throw new CliError(ExitCode.Auth, 'Sign-in timed out. Run "ef init" again to get a new code.');
        }

        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        opts.onTick?.(Math.round((Date.now() - startedAt) / 1000));

        let res;
        try {
            res = await http.post('/api/cli/device/token', { device_code: authorization.deviceCode });
        } catch {
            // A blip mid-poll is not fatal — the code is still valid until it
            // expires, so keep trying rather than making the user start over.
            continue;
        }

        if (res.status === 200 && res.data?.access_token) {
            return {
                accessToken: res.data.access_token,
                brandId: Number(res.data.brand_id),
                brandName: res.data.brand_name ?? null,
                expiresAt: res.data.expires_at ?? null,
            };
        }

        const error = res.data?.error as string | undefined;

        if (error === 'authorization_pending') continue;

        if (error === 'slow_down') {
            // Back off by the server's suggestion, or widen a little ourselves.
            interval = Number(res.data?.interval) || interval + 2;
            continue;
        }

        if (error === 'access_denied') {
            throw new CliError(ExitCode.Auth, 'Sign-in was declined in the browser. Nothing was connected.');
        }

        if (error === 'expired_token') {
            throw new CliError(ExitCode.Auth, 'The sign-in code expired. Run "ef init" again to get a new one.');
        }

        throw new CliError(ExitCode.Auth, 'Sign-in failed. Run "ef init" again to get a new code.');
    }
}

/**
 * Redeem a one-time pairing code from the app (Settings → Claude Code →
 * advanced), for a machine with no browser to approve in.
 *
 * Same endpoint as the poll: the app pre-approves the request, so the very
 * first exchange succeeds.
 */
export async function redeemPairingCode(apiUrl: string, code: string): Promise<DeviceToken> {
    let res;
    try {
        res = await client(apiUrl).post('/api/cli/device/token', { device_code: code.trim() });
    } catch {
        throw new CliError(ExitCode.Network, `Could not reach ${apiUrl}. Check your connection and --api-url.`);
    }

    if (res.status === 200 && res.data?.access_token) {
        return {
            accessToken: res.data.access_token,
            brandId: Number(res.data.brand_id),
            brandName: res.data.brand_name ?? null,
            expiresAt: res.data.expires_at ?? null,
        };
    }

    const error = res.data?.error as string | undefined;

    if (error === 'expired_token') {
        throw new CliError(ExitCode.Auth, 'That pairing code has expired. Generate a new one in the app.');
    }
    // A pairing code is single-use, so a second run is the likeliest cause of
    // an invalid_grant here — worth naming rather than a generic failure.
    throw new CliError(
        ExitCode.Auth,
        'That pairing code is not valid. Codes work once and expire after a few minutes — generate a new one in the app.',
    );
}

/**
 * Best-effort browser open. Never throws and never blocks: if it fails the
 * user still has the URL printed in front of them, which is the actual
 * contract of the flow.
 */
export function openBrowser(url: string): void {
    try {
        const { spawn } = require('child_process') as typeof import('child_process');
        const platform = process.platform;

        const [cmd, args] =
            platform === 'darwin' ? ['open', [url]] :
            platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
            ['xdg-open', [url]];

        const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
        child.on('error', () => { /* no browser here — the printed URL is the fallback */ });
        child.unref();
    } catch {
        // Same: the URL is already on screen.
    }
}
