import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

/**
 * Regression: a component whose server `html` is empty/null (e.g. freshly
 * created) must still push cleanly. The drift check used to fall back to the
 * component's `code` (its slug) as the "server body", which never matched the
 * html-based hash stored at pull time, so every push was rejected with a false
 * "changed on the server since you last pulled".
 */
interface Mock { url: string; close: () => Promise<void>; posts: unknown[]; }

function startMock(): Promise<Mock> {
    const posts: unknown[] = [];
    let html: string | null = null; // server starts with NO html (the bug trigger)
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = (req.url || '').split('?')[0];
                const json = (p: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
                // Create → returns the new component (html null).
                if (req.method === 'POST' && /\/components$/.test(url)) {
                    return json({ pageComponent: { id: 1, code: 'foo', name: 'Foo', html, revision_id: 1 } });
                }
                // Editor GET (used by pull AND by the drift check) — html is null.
                if (req.method === 'GET' && /\/components\/1\/editor$/.test(url)) {
                    return json({ id: 1, code: 'foo', name: 'Foo', html, revision_id: 1, updated_at: '2026-01-01T00:00:00Z' });
                }
                // Editor POST = the actual update/publish.
                if (req.method === 'POST' && /\/components\/1\/editor$/.test(url)) {
                    try { const body = JSON.parse(b); posts.push(body); html = (body as { html?: string }).html ?? null; } catch { posts.push(null); }
                    return json({ success: true, revision_id: 2 });
                }
                json({});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), posts });
        });
    });
}

async function setup(apiUrl: string): Promise<{ root: string; brandRoot: string }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-comp-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return { root, brandRoot: path.join(root, 'elasticfunnels') };
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

test('component push does NOT false-drift when the server html is empty (freshly created)', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        // create → writes components/foo.ef (efmeta) + state contentHash of the empty html.
        assert.equal((await runEf(root, ['components', 'create', 'foo', '--json'])).code, 0);
        const file = path.join(brandRoot, 'components', 'foo.ef');
        assert.ok(fs.existsSync(file), 'component file written by create');
        // Edit only the body, keep the efmeta first line.
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        fs.writeFileSync(file, lines[0] + '\n<h1>hello</h1>\n');

        const push = await runEf(root, ['components', 'push', 'foo', '--json']);
        assert.equal(push.code, 0, `push must succeed, not false-drift; stderr=${push.stderr}`);
        assert.equal(mock.posts.length, 1, 'the edit was actually pushed');
        assert.match((mock.posts[0] as { html?: string }).html ?? '', /<h1>hello<\/h1>/);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
