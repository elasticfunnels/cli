import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Mock {
    url: string;
    close: () => Promise<void>;
    setHtml: (html: string) => void;
    posts: string[];
}

/** Mock pages backend with a mutable server body, so a test can simulate a
 *  second editor changing the page between our pull and our push. */
function startMock(initialHtml: string): Promise<Mock> {
    let html = initialHtml;
    let revision = 1;
    const posts: string[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = (req.url || '').split('?')[0];
                const json = (payload: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
                const page = () => ({ id: 500, slug: 'demo', title: 'Demo', html, revision_id: revision, updated_at: `2026-01-0${revision}T00:00:00Z`, page_type: 'editor' });

                if (req.method === 'GET' && /\/pages\/all$/.test(url)) return json([page()]);
                if (req.method === 'GET' && /\/pages\/500\/editor$/.test(url)) return json(page());
                if (req.method === 'POST' && /\/pages\/500\/editor$/.test(url)) {
                    try { html = JSON.parse(b).html; } catch { /* ignore */ }
                    posts.push(html);
                    revision += 1;
                    return json(page());
                }
                if (/\/(components|scripts|assets|file-manager)/.test(url)) return json([]);
                json({});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), setHtml: (h) => { html = h; revision += 1; }, posts });
        });
    });
}

async function setup(apiUrl: string): Promise<{ root: string; pageFile: string }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-conflict-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return { root, pageFile: path.join(root, 'elasticfunnels', 'pages', 'demo.ef') };
}

function runEf(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

/** Replace the body under the efmeta line, keeping the identity line intact. */
async function editBody(pageFile: string, newBody: string): Promise<void> {
    const content = await fs.promises.readFile(pageFile, 'utf8');
    const efmetaLine = content.split('\n')[0];
    await fs.promises.writeFile(pageFile, `${efmetaLine}\n${newBody}`);
}
function bodyOf(content: string): string {
    return content.split('\n').slice(1).join('\n');
}

test('push is REJECTED when the server changed since pull; pull --merge then push succeeds', async () => {
    const mock = await startMock('line1\nline2\nline3\n');
    const { root, pageFile } = await setup(mock.url);
    try {
        // 1. Pull → establishes baseline + snapshot from the server.
        assert.equal((await runEf(root, ['pull', 'pages'])).code, 0);
        assert.ok(fs.existsSync(pageFile), 'page pulled to disk');

        // 2. A second editor changes the server (line 3), we edit locally (line 1).
        //    Separated by the unchanged line 2 → git can auto-merge without conflict.
        mock.setHtml('line1\nline2\nSERVER3\n');
        await editBody(pageFile, 'LOCAL1\nline2\nline3\n');

        // 3. Push is REJECTED (server moved since we pulled) — nothing uploaded.
        const push = await runEf(root, ['push', 'pages/demo.ef', '--json']);
        assert.equal(push.code, 4, `expected conflict exit; stderr=${push.stderr}`);
        const out = JSON.parse(push.stdout) as { ok: boolean; conflicts: number; pushed: { note?: string }[] };
        assert.equal(out.ok, false);
        assert.equal(out.conflicts, 1);
        assert.match(out.pushed[0].note ?? '', /Changes rejected/);
        assert.equal(mock.posts.length, 0, 'nothing was pushed to the server');

        // 4. Merge the server version in (non-overlapping → clean auto-merge).
        assert.equal((await runEf(root, ['pull', 'pages', '--merge'])).code, 0);
        const mergedBody = bodyOf(await fs.promises.readFile(pageFile, 'utf8'));
        assert.equal(mergedBody, 'LOCAL1\nline2\nSERVER3\n', 'both edits combined');
        assert.doesNotMatch(mergedBody, /<{7}/, 'no conflict markers');

        // 5. Now the push succeeds and carries the merged body.
        const push2 = await runEf(root, ['push', 'pages/demo.ef', '--json']);
        assert.equal(push2.code, 0, `stderr=${push2.stderr}`);
        assert.equal(mock.posts.at(-1), 'LOCAL1\nline2\nSERVER3\n', 'merged body reached the server');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('overlapping edits: pull --merge writes conflict markers; push refuses until resolved', async () => {
    const mock = await startMock('a\nBASE\nc\n');
    const { root, pageFile } = await setup(mock.url);
    try {
        assert.equal((await runEf(root, ['pull', 'pages'])).code, 0);

        // Both sides change the SAME line → overlap.
        mock.setHtml('a\nSERVER\nc\n');
        await editBody(pageFile, 'a\nLOCAL\nc\n');

        // Merge → conflict markers in the body.
        assert.equal((await runEf(root, ['pull', 'pages', '--merge'])).code, 0);
        const merged = await fs.promises.readFile(pageFile, 'utf8');
        assert.match(merged, /<{7}/);
        assert.match(merged, /LOCAL/);
        assert.match(merged, /SERVER/);
        assert.match(merged.split('\n')[0], /^\{\{-- efmeta/, 'efmeta identity line stays intact above the markers');

        // Pushing an unresolved file is refused.
        const push = await runEf(root, ['push', 'pages/demo.ef', '--json']);
        assert.equal(push.code, 4, `stderr=${push.stderr}`);
        assert.match(JSON.parse(push.stdout).pushed[0].note ?? '', /conflict markers/);
        assert.equal(mock.posts.length, 0);

        // Resolve the markers → push goes through.
        await editBody(pageFile, 'a\nRESOLVED\nc\n');
        const push2 = await runEf(root, ['push', 'pages/demo.ef', '--json']);
        assert.equal(push2.code, 0, `stderr=${push2.stderr}`);
        assert.equal(mock.posts.at(-1), 'a\nRESOLVED\nc\n');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('push --force overrides drift and overwrites the server', async () => {
    const mock = await startMock('base\n');
    const { root, pageFile } = await setup(mock.url);
    try {
        assert.equal((await runEf(root, ['pull', 'pages'])).code, 0);
        mock.setHtml('server changed\n');
        await editBody(pageFile, 'my local\n');
        const push = await runEf(root, ['push', 'pages/demo.ef', '--force', '--json']);
        assert.equal(push.code, 0, `stderr=${push.stderr}`);
        assert.equal(mock.posts.at(-1), 'my local\n', '--force pushed local over the server');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
