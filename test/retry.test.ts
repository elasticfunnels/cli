import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Mock { url: string; close: () => Promise<void>; pagesAllHits: () => number; }

/** GET /pages/all returns `failTimes` × 500, then a 200 with []. */
function startMock(failTimes: number, opts: { retryAfter?: string; status?: number } = {}): Promise<Mock> {
    let hits = 0;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                if (/\/pages\/all/.test(req.url || '')) {
                    hits++;
                    if (hits <= failTimes) {
                        const headers: Record<string, string> = { 'content-type': 'application/json' };
                        if (opts.retryAfter) headers['retry-after'] = opts.retryAfter;
                        res.writeHead(opts.status ?? 500, headers);
                        res.end('{"error":"transient"}');
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end('[]');
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), pagesAllHits: () => hits });
        });
    });
}

async function setup(root: string, apiUrl: string): Promise<void> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
}

function runEf(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve) => {
        // Tiny backoff base so the test isn't slow.
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', EF_RETRY_BASE_MS: '1', EF_RETRY_MAX: '5' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
}

test('a GET retries through transient 500s and then succeeds', async () => {
    const mock = await startMock(2); // two 500s, then 200
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-retry-'));
    try {
        await setup(root, mock.url);
        const res = await runEf(root, ['list', 'pages', '--json']);
        assert.equal(res.status, 0, `expected success after retries; stderr=${res.stderr}`);
        assert.equal(mock.pagesAllHits(), 3, 'two retries + one success');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('a 429 with Retry-After is retried, then succeeds', async () => {
    const mock = await startMock(1, { status: 429, retryAfter: '0' });
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-retry-'));
    try {
        await setup(root, mock.url);
        const res = await runEf(root, ['list', 'pages', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(mock.pagesAllHits(), 2, 'one 429 retry + success');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('gives up after RETRY_MAX and reports a network/server failure', async () => {
    const mock = await startMock(99); // always 500
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-retry-'));
    try {
        await setup(root, mock.url);
        const res = await runEf(root, ['list', 'pages', '--json']);
        assert.notEqual(res.status, 0, 'persistent 500 eventually fails');
        // 1 initial + EF_RETRY_MAX(5) retries = 6 attempts.
        assert.equal(mock.pagesAllHits(), 6);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
