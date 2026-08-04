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

const PKG = '@elasticfunnels/cli';
const CACHE_DIR = path.join(os.homedir(), '.config', 'elasticfunnels');
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

interface Cache { latest?: string; checkedAt?: number }

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
        + `\n  Run ${c.cyan(`npm i -g ${PKG}`)} to update.\n`;
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

/** Fire-and-forget: fetch the latest version and cache it. Never awaited, never blocks exit. */
function refreshInBackground(): void {
    try {
        const req = https.get(
            {
                host: 'registry.npmjs.org',
                // scoped package → the `/` in the name is URL-encoded.
                path: `/${PKG.replace('/', '%2F')}/latest`,
                headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
                timeout: 3000,
            },
            (res) => {
                if (res.statusCode !== 200) { res.resume(); return; }
                let data = '';
                res.on('data', (d) => {
                    data += d;
                    if (data.length > 1_000_000) req.destroy(); // guard against a runaway body
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
