import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { withEfMeta } from '../src/sync/efMeta';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-draftwarn-'));
}

interface Mock {
    url: string;
    close: () => Promise<void>;
    /** Parsed JSON bodies of every POST …/editor the CLI sent. */
    editorPosts: Array<{ draft?: boolean } | null>;
}

/** Minimal stand-in for the page editor API: enough for one page update push. */
function startMock(): Promise<Mock> {
    const editorPosts: Mock['editorPosts'] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => (raw += chunk));
            req.on('end', () => {
                const url = req.url || '';
                if (req.method === 'POST' && /\/editor$/.test(url)) {
                    try { editorPosts.push(JSON.parse(raw || '{}')); } catch { editorPosts.push(null); }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ revision_id: 5 }));
                    return;
                }
                if (req.method === 'GET' && /\/editor/.test(url)) {
                    // Canonical body fetch — best-effort in the CLI; answer cleanly.
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ html: '<p>x</p>', revision_id: 5, updated_at: '2026-01-01T00:00:00Z' }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                close: () => new Promise<void>((r) => server.close(() => r())),
                editorPosts,
            });
        });
    });
}

async function setupBrand(root: string, apiUrl: string, saveMode?: 'draft' | 'direct'): Promise<string> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    // Omit saveMode entirely to exercise the built-in default (now "direct").
    const config: Record<string, unknown> = { apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat' };
    if (saveMode) config.saveMode = saveMode;
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify(config));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'fake-key\n');
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
    // A page that already exists on the server (efmeta carries its id), so push
    // takes the "update" path and sends the body through …/editor.
    const page = withEfMeta({ v: 1, type: 'page', id: 42 } as never, '<p>hello</p>');
    await fs.promises.writeFile(path.join(brandRoot, 'pages', 'home.ef'), page);
    return brandRoot;
}

// Spawn asynchronously (NOT spawnSync): the mock HTTP server runs in this same
// process, so the event loop must stay free to answer the child's requests
// while it runs. spawnSync would block the loop and deadlock against the mock.
function runEf(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
}

test('push with saveMode "draft" warns the page is NOT live', async () => {
    const mock = await startMock();
    const root = await tmpDir();
    try {
        await setupBrand(root, mock.url, 'draft');
        const res = await runEf(root, ['push', 'pages/home.ef', '--force']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        assert.match(res.stderr, /Saved as DRAFT/i, 'draft push must warn the change is not live');
        assert.ok(mock.editorPosts.some((b) => b?.draft === true), 'POST …/editor should carry draft:true');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('push uses the direct default (no saveMode in config) and does NOT warn', async () => {
    const mock = await startMock();
    const root = await tmpDir();
    try {
        await setupBrand(root, mock.url); // no saveMode → built-in default "direct"
        const res = await runEf(root, ['push', 'pages/home.ef', '--force']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        assert.doesNotMatch(res.stderr, /Saved as DRAFT/i, 'default push now publishes — no draft warning');
        assert.ok(mock.editorPosts.some((b) => b?.draft === false), 'POST …/editor should carry draft:false');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('push --direct publishes and does NOT warn about drafts', async () => {
    const mock = await startMock();
    const root = await tmpDir();
    try {
        await setupBrand(root, mock.url, 'draft');
        const res = await runEf(root, ['push', 'pages/home.ef', '--direct', '--force']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        assert.doesNotMatch(res.stderr, /Saved as DRAFT/i, '--direct must not warn about drafts');
        assert.ok(mock.editorPosts.some((b) => b?.draft === false), 'POST …/editor should carry draft:false');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
