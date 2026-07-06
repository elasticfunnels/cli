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

interface Mock { url: string; close: () => Promise<void>; contentFetches: number[]; }

/** Lists page #9331 (on disk) and #9332 (missing); records which editor bodies get fetched. */
function startMock(): Promise<Mock> {
    const contentFetches: number[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const url = req.url || '';
                if (req.method === 'GET' && /\/pages\/all/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify([
                        { id: 9331, slug: 'quiz', variant_slug: null, title: 'Quiz', is_active_version: true, updated_at: '2026-05-07T06:00:38-05:00' },
                        { id: 9332, slug: 'new', variant_slug: null, title: 'New', is_active_version: true, updated_at: '2026-05-07T06:00:38-05:00' },
                    ]));
                    return;
                }
                const m = url.match(/\/pages\/(\d+)\/editor/);
                if (req.method === 'GET' && m) {
                    const id = Number(m[1]);
                    contentFetches.push(id);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id, slug: id === 9332 ? 'new' : 'quiz', html: `<h1>${id}</h1>`, revision_id: null, updated_at: '2026-05-07T06:00:38-05:00' }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), contentFetches });
        });
    });
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

test('pull --adopt skips a page already on disk and fetches only the missing one', async () => {
    const mock = await startMock();
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-adopt-'));
    try {
        await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
        await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl: mock.url, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
        await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
        const brandRoot = path.join(root, 'elasticfunnels');
        await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });

        // #9331 is present on disk, with a state entry whose contentHash matches its body.
        const body = '<h1>quiz</h1>';
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'quiz.ef'), withEfMeta({ v: 1, type: 'page', brandId: 7, id: 9331, slug: 'quiz', path: 'pages/quiz.ef' }, body));
        await fs.promises.writeFile(path.join(brandRoot, '.ef-state.json'), JSON.stringify({
            version: 1, brandId: 7,
            pages: { 'pages/quiz.ef': { path: 'pages/quiz.ef', id: 9331, type: 'page', revisionId: null, updatedAt: '2026-05-07T06:00:38-05:00', serverUpdatedAt: '2026-05-07T06:00:38-05:00', contentHash: sha256(Buffer.from(body, 'utf8')) } },
            components: {}, templatePages: {}, scripts: {}, assets: {},
        }));

        const res = await runEf(root, ['pull', 'pages', '--adopt', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(mock.contentFetches.includes(9331), false, '#9331 (on disk, unchanged) must NOT be re-fetched');
        assert.equal(mock.contentFetches.includes(9332), true, '#9332 (missing) must be fetched');
        assert.equal(fs.existsSync(path.join(brandRoot, 'pages', 'new.ef')), true, 'missing page pulled to disk');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
