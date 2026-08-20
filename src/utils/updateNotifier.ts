import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { c } from './log';

/**
 * Lightweight "update available" nudge for global installs.
 *
 * Design goals: never slow a command down, never touch stdout, stay silent in
 * scripts/CI/pipes. We read a small cache synchronously to decide whether to
 * nudge, and refresh that cache with a fire-and-forget, unref'd HTTPS call that
 * cannot keep the process alive — so the notice lags by one run (like
 * npm's own update-notifier) but adds zero latency and no dependency.
 */

export const PKG = '@elasticfunnels/cli';
const CACHE_DIR = path.join(os.homedir(), '.config', 'elasticfunnels');
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
/** Guard against a runaway/hostile response body. The real one is ~2 KB. */
const MAX_BODY_BYTES = 1_000_000;

interface Cache { latest?: string; checkedAt?: number }

/** Registry request for the package's `latest` dist-tag. Shared by both callers. */
function registryRequestOptions(timeoutMs: number): https.RequestOptions {
    return {
        host: 'registry.npmjs.org',
        // scoped package → the `/` in the name is URL-encoded.
        path: `/${PKG.replace('/', '%2F')}/latest`,
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        timeout: timeoutMs,
    };
}

/** Parse "1.2.3" (ignores any pre-release/build suffix). */
function parseVer(v: string): [number, number, number] | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

/** True when `latest` is a strictly higher release than `current`. */
export function isNewer(latest: string, current: string): boolean {
    const a = parseVer(latest);
    const b = parseVer(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
    }
    return false;
}

export function formatUpdateNotice(current: string, latest: string): string {
    return `\n${c.yellow('▲')} Update available ${c.dim(current)} → ${c.green(latest)}`
        + `\n  Run ${c.cyan('ef update')} to install it.\n`;
}

function readCache(): Cache {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Cache; } catch { return {}; }
}

function writeCache(next: Cache): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(next));
    } catch { /* best-effort */ }
}

/**
 * Fetch the latest published version, awaited.
 *
 * The counterpart to {@link refreshInBackground}: `ef update` genuinely needs
 * the answer before it can do anything, so this one resolves/rejects and does
 * NOT unref its socket. It writes the same cache on success, which is why an
 * `ef update` run also silences the nudge on the next command.
 */
export function fetchLatestVersion(timeoutMs = 10_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const req = https.get(registryRequestOptions(timeoutMs), (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`registry.npmjs.org responded with HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (d) => {
                data += d;
                if (data.length > MAX_BODY_BYTES) req.destroy(new Error('registry response was implausibly large'));
            });
            res.on('end', () => {
                let parsed: { version?: string };
                try {
                    parsed = JSON.parse(data) as { version?: string };
                } catch {
                    reject(new Error('could not parse the registry response'));
                    return;
                }
                if (typeof parsed.version !== 'string') {
                    reject(new Error('registry response had no "version" field'));
                    return;
                }
                writeCache({ latest: parsed.version, checkedAt: Date.now() });
                resolve(parsed.version);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(`registry request timed out after ${timeoutMs}ms`)));
    });
}

/** Fire-and-forget: fetch the latest version and cache it. Never awaited, never blocks exit. */
function refreshInBackground(): void {
    try {
        const req = https.get(
            registryRequestOptions(3000),
            (res) => {
                if (res.statusCode !== 200) { res.resume(); return; }
                let data = '';
                res.on('data', (d) => {
                    data += d;
                    if (data.length > MAX_BODY_BYTES) req.destroy(); // guard against a runaway body
                });
                res.on('end', () => {
                    try {
                        const j = JSON.parse(data) as { version?: string };
                        if (j && typeof j.version === 'string') writeCache({ latest: j.version, checkedAt: Date.now() });
                    } catch { /* ignore */ }
                });
            },
        );
        req.on('error', () => { /* offline / DNS / etc. — stay silent */ });
        req.on('timeout', () => req.destroy());
        // Critical: do not keep the event loop (and thus the CLI) alive for this.
        // Unref the socket as soon as it is assigned so a pending check can never
        // delay process exit.
        req.on('socket', (s) => s.unref());
    } catch { /* ignore */ }
}

/**
 * The cached "latest" version, without ever waiting on the network.
 *
 * `ef update --cached` is meant to run from a SessionStart hook, where the
 * whole point of the hook is that it costs nothing. {@link fetchLatestVersion}
 * is the wrong tool there: it is deliberately awaited and does not unref its
 * socket, so it would put a registry round-trip in front of every session.
 *
 * So this reads the same daily cache the nudge uses and kicks off the same
 * fire-and-forget refresh when it is stale. The answer therefore lags by one
 * run on a cold cache — acceptable for a nudge, and the reason the caller must
 * be able to say "unknown" rather than "up to date".
 *
 * @returns the cached version, or null when nothing has been cached yet.
 */
export function readCachedLatestVersion(): string | null {
    const cache = readCache();
    const stale = !cache.checkedAt || (Date.now() - cache.checkedAt) > CHECK_INTERVAL_MS;
    if (stale) refreshInBackground();
    return typeof cache.latest === 'string' ? cache.latest : null;
}

/** True unless the context is one where a nudge would be noise (scripts, CI, pipes, JSON, help/version). */
function shouldNotify(argv: string[]): boolean {
    if (process.env.NO_UPDATE_NOTIFIER || process.env.EF_NO_UPDATE_NOTIFIER || process.env.CI) return false;
    if (!process.stderr.isTTY) return false; // piped/redirected/automation → stay quiet
    const args = argv.slice(2);
    if (args.some((a) => a === '--json' || a === '-v' || a === '--version' || a === '-h' || a === '--help')) return false;
    return true;
}

/**
 * Decide whether to nudge, and kick off a background refresh if the cache is
 * stale. Returns the notice string to print on exit, or null. Pure of side
 * effects on stdout; the caller prints (to stderr) on process 'exit'.
 */
export function getUpdateNotice(currentVersion: string, argv: string[]): string | null {
    if (!shouldNotify(argv)) return null;
    const cache = readCache();
    const stale = !cache.checkedAt || (Date.now() - cache.checkedAt) > CHECK_INTERVAL_MS;
    if (stale) refreshInBackground(); // updates the cache for a later run; never blocks this one
    if (cache.latest && isNewer(cache.latest, currentVersion)) {
        return formatUpdateNotice(currentVersion, cache.latest);
    }
    return null;
}
