import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

/**
 * `ef popups` end to end against a stand-in for Modules/Exitpopups: create
 * from a template then push the file, push by name, refuse a file with no
 * data-modal element before anything is created.
 */

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
const SOURCE = `<div class="fs" data-modal="true"><button data-modal-close="true">x</button><h2>Free shipping</h2></div>
<style>.fs{position:fixed}</style>
<style>.fs h2{margin:0}</style>`;

interface Req { method: string; url: string; body: Record<string, unknown> | null; }

function startMock(): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
    const requests: Req[] = [];
    const popups: Array<{ id: number; name: string }> = [{ id: 3, name: 'Old one' }];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
            const url = (req.url || '').split('?')[0];
            let body: Record<string, unknown> | null = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
            requests.push({ method: req.method || '', url, body });
            const json = (p: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
            if (req.method === 'GET' && url === '/api/brands/7/exit-popups/all') return json(popups);
            if (req.method === 'POST' && url === '/api/brands/7/exit-popups') {
                if (!['default-with-image', 'default-with-video', 'subscribe-modal-1'].includes(String(body?.template))) return json({ message: 'Invalid template.', errors: { template: ['Invalid template.'] } }, 422);
                const p = { id: 9, name: String(body?.name) };
                popups.push(p);
                return json({ exitpopup: { ...p, brand_id: 7 } });
            }
            const m = /^\/api\/brands\/7\/exit-popups\/(\d+)\/builder$/.exec(url);
            if (m && req.method === 'POST') return popups.some((p) => p.id === Number(m[1])) ? json({}) : json({ message: 'nope' }, 404);
            json({ message: 'not found' }, 404);
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) });
    }));
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-popups-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    await fs.promises.writeFile(path.join(root, 'popup.html'), SOURCE);
    await fs.promises.writeFile(path.join(root, 'bad.html'), '<div>no modal</div>');
    return root;
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

test('popups create --file creates from a template, then pushes the file; push by name; bad file sends nothing', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['popups', 'create', 'Free shipping', '--file', 'popup.html', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.deepEqual(JSON.parse(r.stdout), { ok: true, popup: { id: 9, name: 'Free shipping' }, pushed: true });
        const create = mock.requests.find((q) => q.method === 'POST' && q.url.endsWith('/exit-popups'));
        assert.deepEqual(create?.body, { name: 'Free shipping', template: 'default-with-image' });
        const save = mock.requests.find((q) => q.url.endsWith('/exit-popups/9/builder'));
        assert.equal(save?.body?.css, '.fs{position:fixed}\n.fs h2{margin:0}');
        assert.equal(typeof save?.body?.config, 'string', 'config goes as a JSON string (the server json_decodes it)');

        const pushed = await runEf(root, ['popups', 'push', 'free shipping', 'popup.html', '--json']);
        assert.equal(pushed.code, 0, `stderr=${pushed.stderr}`);
        assert.equal(JSON.parse(pushed.stdout).popup.id, 9);

        const before = mock.requests.length;
        const bad = await runEf(root, ['popups', 'create', 'Broken', '--file', 'bad.html']);
        assert.equal(bad.code, 2);
        assert.equal(mock.requests.length, before, 'an invalid file is refused before anything is created');

        assert.equal((await runEf(root, ['popups', 'push', 'nope', 'popup.html'])).code, 7);
        assert.equal(JSON.parse((await runEf(root, ['popups', 'list', '--json'])).stdout).popups.length, 2);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
