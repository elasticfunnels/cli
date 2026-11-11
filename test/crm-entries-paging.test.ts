import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

/** 250 entries, paged like the app (page/per_page ≤ 100), or by an `after` cursor when cursor=true. */
function startMock(opts: { total?: number; cursor?: boolean } = {}): Promise<{ url: string; close: () => Promise<void>; queries: URLSearchParams[] }> {
    const total = opts.total ?? 250;
    const all = Array.from({ length: total }, (_, i) => ({ id: `e${i + 1}`, title: `Entry ${i + 1}` }));
    const queries: URLSearchParams[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url || '/', 'http://x');
            const json = (payload: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
            if (/\/crm\/entities$/.test(u.pathname)) return json([{ id: 5, slug: 'leads', name: 'Leads' }]);
            if (/\/crm\/entities\/5\/entries$/.test(u.pathname)) {
                queries.push(u.searchParams);
                const per = Math.min(100, parseInt(u.searchParams.get('per_page') || '15', 10));
                if (opts.cursor && u.searchParams.has('after')) {
                    const from = parseInt(u.searchParams.get('after')!, 10);
                    const data = all.slice(from, from + per);
                    return json({ data, total, next_after: from + per < total ? String(from + per) : null });
                }
                const page = parseInt(u.searchParams.get('page') || '1', 10);
                const data = all.slice((page - 1) * per, page * per);
                const body: Record<string, unknown> = { data, current_page: page, last_page: Math.max(1, Math.ceil(total / per)), per_page: per, total };
                if (opts.cursor) body.next_after = page * per < total ? String(page * per) : null;
                return json(body);
            }
            res.writeHead(404); res.end('{}');
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), queries });
        });
    });
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-crm-paging-'));
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
        child.stdin.end();
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function withMock(o: { total?: number; cursor?: boolean }, fn: (root: string, m: { queries: URLSearchParams[] }) => Promise<void>): Promise<void> {
    const mock = await startMock(o);
    const root = await setup(mock.url);
    try { await fn(root, mock); } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
}

test('entries: default is one page of 100 and says there is more', () => withMock({}, async (root, m) => {
    const r = await runEf(root, ['crm', 'entries', 'leads']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(m.queries.length, 1);
    assert.equal(m.queries[0].get('per_page'), '100');
    assert.match(r.stderr, /rows 1-100 of 250\. More: --page 2/);
}));

test('entries --all walks every page', () => withMock({}, async (root, m) => {
    const r = await runEf(root, ['crm', 'entries', 'leads', '--all', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const rows = JSON.parse(r.stdout) as { id: string }[];
    assert.equal(rows.length, 250);
    assert.equal(rows[249].id, 'e250');
    assert.deepEqual(m.queries.map((q) => q.get('page')), ['1', '2', '3']);
}));

test('entries --limit 150 keeps 100 per page and trims; --page starts later', () => withMock({}, async (root, m) => {
    const r = await runEf(root, ['crm', 'entries', 'leads', '--limit', '150', '--json']);
    const rows = JSON.parse(r.stdout) as { id: string }[];
    assert.equal(rows.length, 150);
    assert.equal(rows[149].id, 'e150');
    assert.ok(m.queries.every((q) => q.get('per_page') === '100'));
    const p = await runEf(root, ['crm', 'entries', 'leads', '--page', '3']);
    assert.match(p.stderr, /rows 201-250 of 250 entries/);
}));

test('entries --all follows next_after when the server sends a cursor', () => withMock({ cursor: true }, async (root, m) => {
    const r = await runEf(root, ['crm', 'entries', 'leads', '--all', '--json']);
    const rows = JSON.parse(r.stdout) as { id: string }[];
    assert.equal(rows.length, 250);
    assert.equal(new Set(rows.map((x) => x.id)).size, 250, 'no duplicates');
    assert.equal(m.queries[0].get('page'), '1');
    assert.deepEqual(m.queries.slice(1).map((q) => q.get('after')), ['100', '200']);
}));

test('entries --all without a cursor stops at the 10k window with a warning', () => withMock({ total: 10_250 }, async (root, m) => {
    const r = await runEf(root, ['crm', 'entries', 'leads', '--all', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as unknown[]).length, 10_000);
    assert.equal(m.queries.length, 100);
    assert.match(r.stderr, /can't page past 10,000/);
}));
