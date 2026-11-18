import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { validateFaviconFile } from '../src/commands/favicon';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Req { method: string; url: string; type: string; body: Buffer }
interface Mock { url: string; reqs: Req[]; state: { favicon: string | null | undefined }; close: () => Promise<void> }

function startMock(initial: string | null | undefined): Promise<Mock> {
    const reqs: Req[] = [];
    const state = { favicon: initial };
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (d) => chunks.push(d));
            req.on('end', () => {
                const body = Buffer.concat(chunks);
                reqs.push({ method: req.method ?? '', url: req.url ?? '', type: String(req.headers['content-type'] ?? ''), body });
                res.setHeader('Content-Type', 'application/json');
                if (req.url?.startsWith('/icon.png')) { res.statusCode = 200; res.end('{}'); return; }
                if (req.method === 'GET' && req.url === '/api/brands/7') {
                    const out: Record<string, unknown> = { id: 7, name: 'Acme Store' };
                    if (state.favicon !== undefined) out.favicon_link = state.favicon;
                    res.end(JSON.stringify(out));
                    return;
                }
                if (req.method === 'POST' && req.url === '/api/brands/7?_method=PUT') {
                    state.favicon = `${mockUrl}/icon.png`;
                    res.end('{}');
                    return;
                }
                if (req.method === 'PUT' && req.url === '/api/brands/7') {
                    const j = JSON.parse(body.toString('utf8'));
                    if ('favicon' in j && j.favicon === null && state.favicon !== undefined) state.favicon = null;
                    res.end('{}');
                    return;
                }
                res.statusCode = 404; res.end('{}');
            });
        });
        let mockUrl = '';
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            mockUrl = `http://127.0.0.1:${addr.port}`;
            resolve({ url: mockUrl, reqs, state, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function setupProject(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-favicon-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    await fs.promises.writeFile(path.join(root, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    await fs.promises.writeFile(path.join(root, 'icon.svg'), '<svg/>');
    return root;
}

function runEf(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.stdin.end();
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('validateFaviconFile: png/jpg/webp only, not empty, under 1 MB', () => {
    assert.doesNotThrow(() => validateFaviconFile('a.png', 10));
    assert.doesNotThrow(() => validateFaviconFile('a.WEBP', 10));
    assert.throws(() => validateFaviconFile('a.svg', 10), /SVG and ICO are refused/);
    assert.throws(() => validateFaviconFile('a.ico', 10), /SVG and ICO/);
    assert.throws(() => validateFaviconFile('a.png', 0), /empty/);
    assert.throws(() => validateFaviconFile('a.png', 2 * 1024 * 1024), /under 1 MB/);
});

test('set uploads multipart with the unchanged brand name, then reads it back', async () => {
    const mock = await startMock(null);
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['favicon', 'set', 'icon.png', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const post = mock.reqs.find((q) => q.method === 'POST')!;
        assert.equal(post.url, '/api/brands/7?_method=PUT');
        assert.match(post.type, /^multipart\/form-data; boundary=/);
        const text = post.body.toString('latin1');
        assert.match(text, /name="name"\r\n\r\nAcme Store\r\n/);
        assert.match(text, /name="favicon"; filename="icon.png"\r\nContent-Type: image\/png/);
        const out = JSON.parse(r.stdout);
        assert.equal(out.favicon, `${mock.url}/icon.png`);
        assert.equal(out.status, 200);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('set refuses an svg before any request', async () => {
    const mock = await startMock(null);
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['favicon', 'set', 'icon.svg']);
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /SVG and ICO are refused/);
        assert.equal(mock.reqs.length, 0);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('show prints the URL; clear sends favicon:null and confirms', async () => {
    const mock = await startMock('http://127.0.0.1:1/old.png');
    const root = await setupProject(mock.url);
    try {
        const show = await runEf(root, ['favicon', '--json']);
        assert.equal(show.code, 0, `stderr=${show.stderr}`);
        assert.equal(JSON.parse(show.stdout).favicon, 'http://127.0.0.1:1/old.png');
        assert.equal(JSON.parse(show.stdout).status, null, 'unreachable URL reported');

        const r = await runEf(root, ['favicon', 'clear', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const put = mock.reqs.find((q) => q.method === 'PUT')!;
        assert.deepEqual(JSON.parse(put.body.toString('utf8')), { name: 'Acme Store', favicon: null });
        assert.deepEqual(JSON.parse(r.stdout), { ok: true, favicon: null, changed: true });
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('show and clear on a server without favicon_link say so instead of guessing', async () => {
    const mock = await startMock(undefined);
    const root = await setupProject(mock.url);
    try {
        const show = await runEf(root, ['favicon']);
        assert.notEqual(show.code, 0);
        assert.match(show.stderr, /does not report the brand favicon/);
        const clear = await runEf(root, ['favicon', 'clear']);
        assert.notEqual(clear.code, 0);
        assert.equal(mock.reqs.filter((q) => q.method === 'PUT').length, 0);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
