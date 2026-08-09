import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

/**
 * Two ways a full sync stops early — a credential revoked partway through, and
 * Ctrl-C — and the thing they used to have in common: every baseline for the
 * files already written was thrown away, because state was saved only after the
 * last stage. The next pull then saw a populated tree it had no record of.
 */

interface Mock { url: string; close: () => Promise<void>; pageHits: () => number }

interface MockOpts {
    /** Pages to advertise from /pages/all. */
    pageCount: number;
    /** Status for the components list — 401 here aborts the sync mid-way. */
    componentsStatus?: number;
    /** Status for individual page fetches. */
    pageStatus?: number;
    /** Delay each page fetch by this long, so a signal can land mid-sync. */
    pageDelayMs?: number;
}

function startMock(opts: MockOpts): Promise<Mock> {
    let pageHits = 0;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const url = req.url || '';
                const json = (status: number, body: unknown): void => {
                    res.writeHead(status, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(body));
                };

                if (/\/pages\/all/.test(url)) {
                    return json(200, Array.from({ length: opts.pageCount }, (_, i) => ({
                        id: i + 1, slug: `p${i + 1}`, variant_slug: null, title: `P${i + 1}`,
                        is_active_version: true, updated_at: '2026-01-01T00:00:00Z',
                    })));
                }
                const page = /\/pages\/(\d+)\/editor/.exec(url);
                if (page) {
                    pageHits++;
                    const id = Number(page[1]);
                    const send = (): void => {
                        if (opts.pageStatus && opts.pageStatus >= 400) return json(opts.pageStatus, { error: 'nope' });
                        json(200, { id, slug: `p${id}`, html: `<h1>${id}</h1>`, revision_id: null, updated_at: '2026-01-01T00:00:00Z' });
                    };
                    if (opts.pageDelayMs) { setTimeout(send, opts.pageDelayMs); return; }
                    return send();
                }
                if (/\/components\/all/.test(url)) {
                    const status = opts.componentsStatus ?? 200;
                    return status >= 400 ? json(status, { error: 'revoked' }) : json(200, []);
                }
                json(200, []);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                close: () => new Promise<void>((r) => server.close(() => r())),
                pageHits: () => pageHits,
            });
        });
    });
}

async function setup(root: string, apiUrl: string, credential: string): Promise<string> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({
        apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct',
    }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), credential);
    return path.join(root, 'elasticfunnels');
}

interface Run { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null }

function runEf(cwd: string, args: string[], onSpawn?: (kill: () => void) => void): Promise<Run> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], {
            cwd,
            env: { ...process.env, NO_COLOR: '1', EF_RETRY_BASE_MS: '1', EF_RETRY_MAX: '1', NO_UPDATE_NOTIFIER: '1' },
        });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        onSpawn?.(() => child.kill('SIGINT'));
        child.on('close', (status, signal) => resolve({ stdout, stderr, status, signal }));
    });
}

/** Entries recorded in `<brandRoot>/.ef-state.json`, across whatever buckets it uses. */
function stateEntryCount(brandRoot: string): number {
    const p = path.join(brandRoot, '.ef-state.json');
    if (!fs.existsSync(p)) return 0;
    const state = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    let n = 0;
    for (const v of Object.values(state)) {
        if (Array.isArray(v)) n += v.length;
        else if (v && typeof v === 'object') n += Object.keys(v as object).length;
    }
    return n;
}

test('a credential revoked mid-sync stops the pull and names the device fix', async () => {
    const mock = await startMock({ pageCount: 3, componentsStatus: 401 });
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-revoked-'));
    try {
        const brandRoot = await setup(root, mock.url, 'efc_revoked\n');
        const res = await runEf(root, ['pull']);

        assert.equal(res.status, 3, `expected exit 3 (auth), got ${res.status}\nstderr=${res.stderr}`);
        assert.match(res.stderr, /Connected devices/, 'a device token must point at the devices list, not the API key page');
        assert.match(res.stderr, /ef login/, 'must name the command that fixes it');
        assert.doesNotMatch(res.stderr, /valid ElasticFunnels brand API key/, 'the old, wrong advice is gone');

        // The pages that landed before the 401 keep their baselines.
        assert.equal(fs.existsSync(path.join(brandRoot, 'pages', 'p1.ef')), true);
        assert.ok(stateEntryCount(brandRoot) >= 3, 'baselines for the pulled pages were saved despite the abort');

        // A partial sync is not a pull: --if-stale must not skip the retry.
        const cfg = JSON.parse(fs.readFileSync(path.join(root, '.ef', 'config.json'), 'utf8'));
        assert.ok(!cfg.lastPulledAt, `lastPulledAt must stay unset after a partial sync, got ${cfg.lastPulledAt}`);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
        await mock.close();
    }
});

test('a legacy key gets the API-key advice, not the device advice', async () => {
    const mock = await startMock({ pageCount: 1, componentsStatus: 401 });
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-legacykey-'));
    try {
        await setup(root, mock.url, 'plain-brand-key\n');
        const res = await runEf(root, ['pull']);
        assert.equal(res.status, 3);
        assert.match(res.stderr, /Settings → All Settings → API/);
        assert.doesNotMatch(res.stderr, /Connected devices/);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
        await mock.close();
    }
});

test('per-item 401s stop the sync instead of firing every remaining request', async () => {
    // 40 pages, all rejected. Without fail-fast this makes 40 doomed requests
    // and buries the cause under 40 identical warnings.
    const mock = await startMock({ pageCount: 40, pageStatus: 401 });
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-failfast-'));
    try {
        await setup(root, mock.url, 'efc_revoked\n');
        const res = await runEf(root, ['pull']);
        assert.equal(res.status, 3, `expected exit 3 (auth), got ${res.status}\nstderr=${res.stderr}`);
        assert.ok(mock.pageHits() < 40, `expected fail-fast, but all ${mock.pageHits()} pages were requested`);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
        await mock.close();
    }
});

/*
 * Interrupt timing: pulls run 8-wide, so the sync must be slow enough that a
 * signal at ~500ms lands after the first wave has committed files but before
 * the last one starts. 24 pages at 250ms is three waves ≈ 750ms of work.
 */
const SLOW_SYNC = { pageCount: 24, pageDelayMs: 250 };
const KILL_AFTER_MS = 500;

test('Ctrl-C mid-pull exits 130 and keeps baselines for what already landed', async () => {
    const mock = await startMock(SLOW_SYNC);
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-interrupt-'));
    try {
        const brandRoot = await setup(root, mock.url, 'efc_tok\n');
        const res = await runEf(root, ['pull'], (kill) => { setTimeout(kill, KILL_AFTER_MS); });

        assert.equal(res.status, 130, `expected exit 130 (interrupted), got ${res.status} signal=${res.signal}\nstderr=${res.stderr}`);
        assert.match(res.stderr, /Interrupted/i);
        assert.match(res.stderr, /re-run "ef pull"/i, 'must say how to finish the job');

        // The whole point: what landed is recorded, so the next pull has an
        // accurate baseline instead of treating every file as unknown.
        assert.ok(stateEntryCount(brandRoot) > 0, 'interrupted sync still saved baselines for completed downloads');

        const cfg = JSON.parse(fs.readFileSync(path.join(root, '.ef', 'config.json'), 'utf8'));
        assert.ok(!cfg.lastPulledAt, 'an interrupted sync must not count as a pull');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
        await mock.close();
    }
});

test('after an interrupt, a second pull completes and stamps lastPulledAt', async () => {
    const mock = await startMock(SLOW_SYNC);
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-resume-'));
    try {
        await setup(root, mock.url, 'efc_tok\n');
        const first = await runEf(root, ['pull'], (kill) => { setTimeout(kill, KILL_AFTER_MS); });
        assert.equal(first.status, 130, `stderr=${first.stderr}`);

        const second = await runEf(root, ['pull']);
        assert.equal(second.status, 0, `resume should succeed, got ${second.status}\nstderr=${second.stderr}`);
        const cfg = JSON.parse(fs.readFileSync(path.join(root, '.ef', 'config.json'), 'utf8'));
        assert.ok(cfg.lastPulledAt, 'a completed pull stamps lastPulledAt');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
        await mock.close();
    }
});
