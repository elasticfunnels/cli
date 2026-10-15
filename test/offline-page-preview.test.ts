import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { withEfMeta } from '../src/sync/efMeta';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
const PREVIEW = 'https://example.test/blog/post?key=abc&preview=1';

interface Mock { url: string; close: () => Promise<void>; previewUrlCalls: number; }

/** Page editor API for one page (#42) whose status the test picks. */
function startMock(status: string): Promise<Mock> {
    const mock = { previewUrlCalls: 0 } as Mock;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => undefined);
            req.on('end', () => {
                const p = (req.url || '').split('?')[0];
                const json = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
                if (/\/pages\/all$/.test(p)) return json([{ id: 42, slug: 'blog/post', status }]);
                if (req.method === 'POST' && /\/pages\/42\/editor$/.test(p)) return json({ success: true, revision_id: null, preview_url: PREVIEW });
                if (/\/pages\/42\/editor\/preview-url$/.test(p)) { mock.previewUrlCalls++; return json({ url: PREVIEW }); }
                if (/\/pages\/42\/editor\/live-url$/.test(p)) return json({ url: 'https://example.test/blog/post' });
                if (/\/pages\/42\/editor$/.test(p)) return json({ id: 42, slug: 'blog/post', status, html: '<p>x</p>', revision_id: null, updated_at: '2026-01-01T00:00:00Z' });
                json({});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            mock.url = `http://127.0.0.1:${addr.port}`;
            mock.close = () => new Promise<void>((r) => server.close(() => r()));
            resolve(mock);
        });
    });
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-offline-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    const dir = path.join(root, 'elasticfunnels', 'pages', 'blog');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'post.ef'), withEfMeta({ v: 1, type: 'page', id: 42, slug: 'blog/post' } as never, '<p>x</p>'));
    return root;
}

// Async spawn: the mock runs in this process and must keep answering.
function runEf(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

async function withMock(status: string, fn: (root: string, mock: Mock) => Promise<void>): Promise<void> {
    const mock = await startMock(status);
    const root = await setup(mock.url);
    try { await fn(root, mock); } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

test('push of an offline page prints no preview link and says how to publish', () => withMock('offline', async (root) => {
    const res = await runEf(root, ['push', 'pages/blog/post.ef', '--force']);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /preview:/);
    assert.match(res.stderr, /OFFLINE/);
    assert.match(res.stderr, /ef pages settings blog\/post --status published/);
}));

test('push of a published page still prints the preview link', () => withMock('published', async (root) => {
    const res = await runEf(root, ['push', 'pages/blog/post.ef', '--force']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /preview: https:\/\/example\.test/);
    assert.doesNotMatch(res.stderr, /OFFLINE/);
}));

test('ef preview of an offline page prints no URL and never asks for one', () => withMock('offline', async (root, mock) => {
    const res = await runEf(root, ['preview', 'blog/post']);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /https:\/\//);
    assert.match(res.stderr, /OFFLINE/);
    assert.equal(mock.previewUrlCalls, 0);
}));

test('ef pages preview --json of an offline page returns null URLs with the status', () => withMock('offline', async (root) => {
    const res = await runEf(root, ['pages', 'preview', 'blog/post', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.previewUrl, null);
    assert.equal(out.liveUrl, null);
    assert.equal(out.status, 'offline');
}));

test('ef pages publish of an offline page warns it is still offline', () => withMock('offline', async (root) => {
    const res = await runEf(root, ['pages', 'publish', 'blog/post']);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /Preview: https/);
    assert.match(res.stderr, /OFFLINE/);
}));
