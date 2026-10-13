import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

/**
 * `ef funnels create --domain` used to send is_default: true always, and the
 * server then clears the domain's current default (FunnelsController::store,
 * clearOtherDefaultsForDomain): creating a funnel silently took a live domain
 * over. Now it is default only when the domain has none, or with --default.
 */

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
interface Req { method: string; url: string; body: Record<string, unknown> | null; }

function startMock(defaults: Record<number, number[]>): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
    const requests: Req[] = [];
    let nextId = 900;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
            const [url, query = ''] = (req.url || '').split('?');
            let body: Record<string, unknown> | null = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
            requests.push({ method: req.method || '', url: req.url || '', body });
            const json = (p: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
            if (req.method === 'GET' && url === '/api/brands/7/funnels') {
                const page = Number(new URLSearchParams(query).get('page') || 1);
                // Two pages, so pagination is exercised: page 2 holds the defaults.
                const rows = page === 1
                    ? [{ id: 1, domains: [{ domain_id: 31, is_default: 0 }] }]
                    : Object.entries(defaults).flatMap(([dom, ids]) => ids.map((id) => ({ id, domains: [{ domain_id: Number(dom), is_default: 1 }] })));
                return json({ data: rows, current_page: page, last_page: 2 });
            }
            if (req.method === 'POST' && url === '/api/brands/7/funnels') return json({ id: nextId++, code: `f${nextId}`, title: body?.title });
            json({ message: 'not found' }, 404);
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) });
    }));
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-fcreate-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
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

const created = (m: { requests: Req[] }) => m.requests.filter((r) => r.method === 'POST' && r.url === '/api/brands/7/funnels').at(-1)?.body;

test('funnels create --domain: not default when the domain has one; default when it has none; flags override', async () => {
    const mock = await startMock({ 31: [5] });
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['funnels', 'create', 'Kit funnel', '--domain', '31', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.deepEqual(created(mock)?.domains, [{ domain_id: 31, is_default: false }]);
        assert.equal(JSON.parse(r.stdout).domain_default, false);

        assert.equal((await runEf(root, ['funnels', 'create', 'Fresh', '--domain', '44'])).code, 0);
        assert.deepEqual(created(mock)?.domains, [{ domain_id: 44, is_default: true }], 'a domain with no default gets one');

        const lookups = mock.requests.filter((q) => q.method === 'GET' && q.url.startsWith('/api/brands/7/funnels?')).length;
        assert.equal((await runEf(root, ['funnels', 'create', 'Take over', '--domain', '31', '--default'])).code, 0);
        assert.deepEqual(created(mock)?.domains, [{ domain_id: 31, is_default: true }]);
        assert.equal((await runEf(root, ['funnels', 'create', 'Quiet', '--domain', '44', '--not-default'])).code, 0);
        assert.deepEqual(created(mock)?.domains, [{ domain_id: 44, is_default: false }]);
        assert.equal(mock.requests.filter((q) => q.method === 'GET' && q.url.startsWith('/api/brands/7/funnels?')).length, lookups, 'explicit flags skip the lookup');

        assert.equal((await runEf(root, ['funnels', 'create', 'Both', '--domain', '31', '--default', '--not-default'])).code, 2);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
