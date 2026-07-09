import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Mock { url: string; close: () => Promise<void>; }

/** #1 (good) serves content; #2 (bad) always returns `badStatus`. */
function startMock(badStatus: number): Promise<Mock> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const url = req.url || '';
                if (req.method === 'GET' && /\/pages\/all/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify([
                        { id: 1, slug: 'good', variant_slug: null, title: 'Good', is_active_version: true, updated_at: '2026-01-01T00:00:00Z' },
                        { id: 2, slug: 'bad', variant_slug: null, title: 'Bad', is_active_version: true, updated_at: '2026-01-01T00:00:00Z' },
                    ]));
                    return;
                }
                if (req.method === 'GET' && /\/pages\/1\/editor/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 1, slug: 'good', html: '<h1>good</h1>', revision_id: null, updated_at: '2026-01-01T00:00:00Z' }));
                    return;
                }
                if (req.method === 'GET' && /\/pages\/2\/editor/.test(url)) {
                    res.writeHead(badStatus, { 'content-type': 'application/json' });
                    res.end('{"error":"x"}');
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function setup(root: string, apiUrl: string): Promise<string> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return path.join(root, 'elasticfunnels');
}

function runEf(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', EF_RETRY_BASE_MS: '1', EF_RETRY_MAX: '1' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
}

test('a real per-page failure (5xx) makes pull exit non-zero but still pulls the good page', async () => {
    const mock = await startMock(500);
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-partial-'));
    try {
        const brandRoot = await setup(root, mock.url);
        const res = await runEf(root, ['pull', 'pages', '--json']);
        assert.equal(res.status, 6, `expected exit 6 (server), got ${res.status}\nstderr=${res.stderr}`);
        assert.match(res.stderr, /FAILED to pull/i);
        assert.equal(fs.existsSync(path.join(brandRoot, 'pages', 'good.ef')), true, 'good page still pulled');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('a deleted page (404) is benign — pull still exits 0', async () => {
    const mock = await startMock(404);
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-partial-'));
    try {
        const brandRoot = await setup(root, mock.url);
        const res = await runEf(root, ['pull', 'pages', '--json']);
        assert.equal(res.status, 0, `deleted-on-server is not a failure; stderr=${res.stderr}`);
        assert.doesNotMatch(res.stderr, /FAILED to pull/i);
        assert.equal(fs.existsSync(path.join(brandRoot, 'pages', 'good.ef')), true);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
