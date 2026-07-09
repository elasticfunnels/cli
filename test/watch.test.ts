import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { once } from 'events';
import { setTimeout as delay } from 'timers/promises';
import { withEfMeta } from '../src/sync/efMeta';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Mock { url: string; close: () => Promise<void>; editorPosts: number[]; }

function startMock(): Promise<Mock> {
    const editorPosts: number[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const url = req.url || '';
                const post = url.match(/\/pages\/(\d+)\/editor$/);
                if (req.method === 'POST' && post) {
                    editorPosts.push(Number(post[1]));
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ revision_id: 1 }));
                    return;
                }
                if (req.method === 'GET' && /\/pages\/\d+\/editor/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ html: '<h1>watched</h1>', revision_id: 1, updated_at: '2026-01-01T00:00:00Z' }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), editorPosts });
        });
    });
}

async function setup(root: string, apiUrl: string): Promise<string> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
    return brandRoot;
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await delay(50); }
    return pred();
}

test('ef watch auto-pushes a changed file, then stops cleanly on SIGINT', async () => {
    const mock = await startMock();
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-watch-'));
    const brandRoot = await setup(root, mock.url);
    const child = spawn(process.execPath, [BIN_PATH, 'watch', '--json', '--debounce', '50'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    try {
        await delay(1200); // let chokidar settle before creating files (ignoreInitial)
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'x.ef'), withEfMeta({ v: 1, type: 'page', brandId: 7, id: 42, slug: 'x', path: 'pages/x.ef' }, '<h1>local</h1>'));

        const pushed = await waitUntil(() => mock.editorPosts.includes(42), 5000);
        assert.equal(pushed, true, `watch should push the changed file; stdout=${out}`);
        assert.match(out, /"event":\s*"pushed"/);
    } finally {
        child.kill('SIGINT');
        await once(child, 'close');
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
