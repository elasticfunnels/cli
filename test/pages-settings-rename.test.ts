import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { parseEfMeta, withEfMeta } from '../src/sync/efMeta';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-settings-'));
}

interface Mock { url: string; close: () => Promise<void>; }

/** Lists one page (cognihoney/#42) and echoes the PUT settings back as the page. */
function startMock(newSlug: string): Promise<Mock> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                const url = req.url || '';
                if (req.method === 'GET' && /\/pages\/all/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify([{ id: 42, slug: 'cognihoney', variant_slug: null, title: 'Cognihoney', is_active_version: true, updated_at: '2026-01-01T00:00:00Z' }]));
                    return;
                }
                if (req.method === 'PUT' && /\/pages\/42$/.test(url)) {
                    let body: Record<string, unknown> = {};
                    try { body = JSON.parse(raw || '{}'); } catch { /* {} */ }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 42, slug: newSlug, variant_slug: null, title: body.title ?? 'Cognihoney', updated_at: '2026-01-02T00:00:00Z' }));
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

async function setupBrand(root: string, apiUrl: string): Promise<string> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
    await fs.promises.writeFile(
        path.join(brandRoot, 'pages', 'cognihoney.ef'),
        withEfMeta({ v: 1, type: 'page', brandId: 7, id: 42, slug: 'cognihoney', path: 'pages/cognihoney.ef' }, '<h1>Body</h1>'),
    );
    return brandRoot;
}

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

test('pages settings --slug renames the local .ef file (body preserved, efmeta + state updated)', async () => {
    const mock = await startMock('concentration');
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root, mock.url);
        const res = await runEf(root, ['pages', 'settings', 'cognihoney', '--slug', 'concentration', '--title', 'Concentration', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);

        const oldFile = path.join(brandRoot, 'pages', 'cognihoney.ef');
        const newFile = path.join(brandRoot, 'pages', 'concentration.ef');
        assert.equal(fs.existsSync(oldFile), false, 'old file removed');
        assert.equal(fs.existsSync(newFile), true, 'new file written');

        const { meta, body } = parseEfMeta(await fs.promises.readFile(newFile, 'utf8'));
        assert.equal(meta?.id, 42);
        assert.equal(meta?.slug, 'concentration');
        assert.equal(meta?.path, 'pages/concentration.ef');
        assert.match(body, /<h1>Body<\/h1>/, 'body preserved');

        const state = JSON.parse(await fs.promises.readFile(path.join(brandRoot, '.ef-state.json'), 'utf8'));
        assert.ok(state.pages['pages/concentration.ef'], 'state has new path');
        assert.equal(state.pages['pages/cognihoney.ef'], undefined, 'state dropped old path');

        const parsed = JSON.parse(res.stdout);
        assert.deepEqual(parsed.renamed, { from: 'pages/cognihoney.ef', to: 'pages/concentration.ef' });
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pages settings without a slug change does not rename', async () => {
    const mock = await startMock('cognihoney'); // slug unchanged
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root, mock.url);
        const res = await runEf(root, ['pages', 'settings', 'cognihoney', '--title', 'New Title', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(fs.existsSync(path.join(brandRoot, 'pages', 'cognihoney.ef')), true, 'file stays put');
        assert.equal(JSON.parse(res.stdout).renamed, null);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
