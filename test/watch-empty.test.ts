import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { once } from 'events';
import { setTimeout as delay } from 'timers/promises';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Mock { url: string; close: () => Promise<void>; creates: number; editorHtml: string[]; }

function startMock(): Promise<Mock> {
    let creates = 0;
    const editorHtml: string[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = req.url || '';
                if (req.method === 'POST' && /\/pages$/.test(url)) {
                    creates++;
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ page: { id: 500, slug: 'newpage', title: 'Newpage' } }));
                    return;
                }
                if (/\/pages\/\d+\/editor/.test(url)) {
                    if (req.method === 'POST') { try { editorHtml.push(JSON.parse(b).html); } catch { /* ignore */ } }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 500, slug: 'newpage', html: '', revision_id: 1, updated_at: '2026-01-01T00:00:00Z' }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), get creates() { return creates; }, editorHtml });
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

test('watch skips an empty new file, then creates it with content (no empty page)', async () => {
    const mock = await startMock();
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-watchempty-'));
    const brandRoot = await setup(root, mock.url);
    const child = spawn(process.execPath, [BIN_PATH, 'watch', '--debounce', '80'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    try {
        await delay(1200);
        const f = path.join(brandRoot, 'pages', 'newpage.ef');
        await fs.promises.writeFile(f, '');            // editor creates the file empty
        await delay(500);                              // watcher would fire here
        await fs.promises.writeFile(f, '<h1>HELLO</h1>'); // then you type + save

        // Wait for exactly the content push.
        for (let i = 0; i < 60 && mock.editorHtml.length === 0; i++) await delay(50);
        await delay(400); // settle to catch any stray extra push

        assert.equal(mock.creates, 1, 'exactly one page created (empty file did not create one)');
        assert.deepEqual(mock.editorHtml, ['<h1>HELLO</h1>'], 'the single push carried the real content, never ""');
        assert.match(await fs.promises.readFile(f, 'utf8'), /efmeta.*\n<h1>HELLO<\/h1>/s);
    } finally {
        child.kill('SIGINT');
        await once(child, 'close');
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
