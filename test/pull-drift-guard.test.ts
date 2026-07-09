import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { withEfMeta } from '../src/sync/efMeta';
import { sha256 } from '../src/utils/fs';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Mock { url: string; close: () => Promise<void>; }

function startMock(serverHtml: string): Promise<Mock> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const url = req.url || '';
                if (req.method === 'GET' && /\/pages\/all/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify([{ id: 42, slug: 'home', variant_slug: null, title: 'Home', is_active_version: true, updated_at: '2026-01-01T00:00:00Z' }]));
                    return;
                }
                if (req.method === 'GET' && /\/pages\/42\/editor/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 42, slug: 'home', html: serverHtml, revision_id: null, updated_at: '2026-01-01T00:00:00Z' }));
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
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
    // Local file has an unpushed edit; baseline records a DIFFERENT original → drift.
    await fs.promises.writeFile(path.join(brandRoot, 'pages', 'home.ef'), withEfMeta({ v: 1, type: 'page', brandId: 7, id: 42, slug: 'home', path: 'pages/home.ef' }, '<h1>LOCAL EDIT</h1>'));
    await fs.promises.writeFile(path.join(brandRoot, '.ef-state.json'), JSON.stringify({
        version: 1, brandId: 7,
        pages: { 'pages/home.ef': { path: 'pages/home.ef', id: 42, type: 'page', revisionId: null, contentHash: sha256(Buffer.from('<h1>ORIG</h1>', 'utf8')) } },
        components: {}, templatePages: {}, scripts: {}, assets: {},
    }));
    return brandRoot;
}

function runEf(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
}

test('pull KEEPS a locally-edited file and warns (no --force)', async () => {
    const mock = await startMock('<h1>SERVER</h1>');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-drift-'));
    try {
        const brandRoot = await setup(root, mock.url);
        const res = await runEf(root, ['pull', 'page', 'home']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.match(await fs.promises.readFile(path.join(brandRoot, 'pages', 'home.ef'), 'utf8'), /LOCAL EDIT/, 'local edit preserved');
        assert.match(res.stderr, /Kept local/i, 'warns that it kept the local file');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pull --force overwrites the locally-edited file with the server version', async () => {
    const mock = await startMock('<h1>SERVER</h1>');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-drift-'));
    try {
        const brandRoot = await setup(root, mock.url);
        const res = await runEf(root, ['pull', 'page', 'home', '--force']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.match(await fs.promises.readFile(path.join(brandRoot, 'pages', 'home.ef'), 'utf8'), /SERVER/, 'server version taken');
        // The overwritten local edit is preserved in history.
        const histDir = path.join(brandRoot, '.ef-history', 'pages', 'home.ef');
        const snaps = await fs.promises.readdir(histDir);
        assert.match(await fs.promises.readFile(path.join(histDir, snaps[0]), 'utf8'), /LOCAL EDIT/);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
