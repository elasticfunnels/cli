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

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-hist-'));
}

interface Mock { url: string; close: () => Promise<void>; }

/** Lists page #42 (slug "home") and serves the given html as its editor body. */
function startMock(html: string): Promise<Mock> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const url = req.url || '';
                if (req.method === 'GET' && /\/pages\/all/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify([{ id: 42, slug: 'home', variant_slug: null, title: 'Home', is_active_version: true, updated_at: '2026-01-02T00:00:00Z' }]));
                    return;
                }
                if (req.method === 'GET' && /\/pages\/42\/editor/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 42, slug: 'home', variant_slug: null, title: 'Home', html, revision_id: 1, updated_at: '2026-01-02T00:00:00Z' }));
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

test('pull snapshots the previous version into .ef-history before overwriting', async () => {
    const mock = await startMock('<h1>NEW</h1>');
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root, mock.url);
        const pageFile = path.join(brandRoot, 'pages', 'home.ef');
        await fs.promises.writeFile(pageFile, withEfMeta({ v: 1, type: 'page', brandId: 7, id: 42, slug: 'home', path: 'pages/home.ef' }, '<h1>OLD</h1>'));
        // Baseline so the local file counts as "unchanged since last pull" (not local drift),
        // making the server change safe to take (overwrite + snapshot).
        await fs.promises.writeFile(path.join(brandRoot, '.ef-state.json'), JSON.stringify({
            version: 1, brandId: 7,
            pages: { 'pages/home.ef': { path: 'pages/home.ef', id: 42, type: 'page', revisionId: null, contentHash: sha256(Buffer.from('<h1>OLD</h1>', 'utf8')) } },
            components: {}, templatePages: {}, scripts: {}, assets: {},
        }));

        const res = await runEf(root, ['pull', 'page', 'home', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);

        // New content written to the live file.
        assert.match(await fs.promises.readFile(pageFile, 'utf8'), /NEW/);

        // Old content preserved in .ef-history.
        const histDir = path.join(brandRoot, '.ef-history', 'pages', 'home.ef');
        const snaps = await fs.promises.readdir(histDir);
        assert.equal(snaps.length, 1, 'one snapshot kept');
        assert.match(await fs.promises.readFile(path.join(histDir, snaps[0]), 'utf8'), /OLD/, 'snapshot holds the previous body');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pull does NOT snapshot when the content is unchanged', async () => {
    const sameBody = '<h1>SAME</h1>';
    const mock = await startMock(sameBody);
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root, mock.url);
        const pageFile = path.join(brandRoot, 'pages', 'home.ef');
        // Pre-seed with exactly what the pull will write (minimal efmeta + same body).
        await fs.promises.writeFile(pageFile, withEfMeta({ v: 1, type: 'page', brandId: 7, id: 42, slug: 'home', path: 'pages/home.ef' }, sameBody));

        const res = await runEf(root, ['pull', 'page', 'home', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(fs.existsSync(path.join(brandRoot, '.ef-history')), false, 'no history dir for a no-op pull');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
