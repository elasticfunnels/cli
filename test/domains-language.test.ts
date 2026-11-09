import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Req { method: string; url: string; body: Record<string, unknown> | null }

/** Brand 7 owns fallback72.ro (#21); "de" is not a brand language (422, like UpdateDomain). */
function startMock(): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
    const requests: Req[] = [];
    let language: string | null = null;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (d) => (raw += d));
            req.on('end', () => {
                const url = (req.url || '').split('?')[0];
                let body: Record<string, unknown> | null = null;
                try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
                requests.push({ method: req.method || '', url: req.url || '', body });
                const json = (p: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
                const row = () => ({ id: 21, domain: 'fallback72.ro', status: 'validated', dedicated_domain: 1, language });
                if (req.method === 'GET' && url === '/api/brands/7/domains') return json({ data: [row()], last_page: 1 });
                if (req.method === 'GET' && url === '/api/brands/7/domains/21') return json(row());
                if (req.method === 'PUT' && url === '/api/brands/7/domains/21') {
                    const l = body?.language as string | null;
                    if (l === 'de') return json({ message: 'invalid', errors: { language: ['"de" is not one of this brand\'s languages.'] } }, 422);
                    language = l;
                    return json(row());
                }
                json({ message: 'not found' }, 404);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-domains-lang-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return root;
}

function runEf(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

const puts = (reqs: Req[]) => reqs.filter((r) => r.method === 'PUT');

test('domains language: bind, show, list, clear', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const set = await runEf(root, ['domains', 'language', 'fallback72.ro', 'RO']);
        assert.equal(set.code, 0, set.stderr);
        assert.match(set.stdout + set.stderr, /fallback72\.ro now serves ro/);
        assert.deepEqual(puts(mock.requests)[0].body, { language: 'ro' }, 'sends only the language');

        const show = await runEf(root, ['domains', 'language', 'fallback72.ro', '--json']);
        assert.equal(JSON.parse(show.stdout).language, 'ro');
        const list = await runEf(root, ['domains', 'list']);
        assert.match(list.stdout + list.stderr, /language/);
        assert.match(list.stdout + list.stderr, /\bro\b/);

        const clear = await runEf(root, ['domains', 'lang', '21', 'none']);
        assert.equal(clear.code, 0, clear.stderr);
        assert.deepEqual(puts(mock.requests)[1].body, { language: null });
        assert.match(clear.stdout + clear.stderr, /has no language now/);
    } finally { await mock.close(); }
});

test('domains language: a refusal is shown and exits non-zero', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const r = await runEf(root, ['domains', 'language', 'fallback72.ro', 'de']);
        assert.notEqual(r.code, 0);
        assert.match(r.stderr + r.stdout, /not one of this brand's languages/);
    } finally { await mock.close(); }
});
