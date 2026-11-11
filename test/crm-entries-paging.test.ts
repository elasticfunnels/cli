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
                    // Like the app: page/last_page in a cursor reply still describe page 1, and total is capped at 10k.
                    return json({ data, total: Math.min(total, 10_000), current_page: 1, last_page: Math.ceil(Math.min(total, 10_000) / per), next_after: data.length === per ? String(from + per) : null });
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
    assert.match(r.stderr, /Stopped after page 100 \(10000 entries\): this server pages by number only up to row 10,000/);
}));

test('entries --all with a cursor goes past 10k and does not warn', () => withMock({ total: 10_250, cursor: true }, async (root) => {
    const r = await runEf(root, ['crm', 'entries', 'leads', '--all', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as unknown[]).length, 10_250);
    assert.doesNotMatch(r.stderr, /Stopped after page/);
    const t = await runEf(root, ['crm', 'entries', 'leads', '--all']);
    assert.match(t.stderr, /rows 1-10250 of 10250 entries/, 'total never below what was fetched');
}));

test('entries --all with a cursor stops on an empty page after an exactly full one', () => withMock({ total: 200, cursor: true }, async (root, m) => {
    const r = await runEf(root, ['crm', 'entries', 'leads', '--all', '--json']);
    assert.equal((JSON.parse(r.stdout) as unknown[]).length, 200);
    assert.equal(m.queries.length, 3, 'page 1, after=100, after=200 (empty)');
}));

test('entry ids that start with "-" are ids, not options; "--typo" is still refused', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ entry: { id: '-Xq3', title: 't' } })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const root = await setup(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
        const g = await runEf(root, ['crm', 'entries', 'get', '-Xq3']);
        assert.equal(g.code, 0, g.stderr);
        assert.ok(seen.includes('GET /api/brands/7/crm/entries/-Xq3'));
        const d = await runEf(root, ['crm', 'entries', 'delete', '-Xq3', '--force', '--json']);
        assert.equal(d.code, 0, d.stderr);
        assert.ok(seen.includes('DELETE /api/brands/7/crm/entries/-Xq3'));
        const t = await runEf(root, ['crm', 'entries', 'delete', '--frce']);
        assert.notEqual(t.code, 0);
        assert.match(t.stderr, /Unknown option "--frce"/);
        assert.ok(!seen.some((x) => x.includes('--frce')));
    } finally { await new Promise<void>((r) => server.close(() => r())); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('entries --all keeps each id once when pages repeat rows', async () => {
    const server = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        const page = parseInt(u.searchParams.get('page') || '1', 10);
        // An unstable sort: page 2 repeats half of page 1.
        const data = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: `e${i}` })) : Array.from({ length: 100 }, (_, i) => ({ id: `e${i + 50}` }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data, current_page: page, last_page: 2, total: 150 }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const root = await setup(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
        const r = await runEf(root, ['crm', 'entries', '5', '--all', '--json']);
        assert.equal((JSON.parse(r.stdout) as unknown[]).length, 150);
        assert.match(r.stderr, /Dropped 50 repeated rows/);
    } finally { await new Promise<void>((r) => server.close(() => r())); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('entries purge: counts, refuses without --yes, deletes every matching id with --yes', async () => {
    const deleted: string[] = []; const lists: URLSearchParams[] = [];
    const server = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        const json = (p: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
        if (req.method === 'GET' && /\/crm\/entities$/.test(u.pathname)) return json([{ id: 5, slug: 'leads' }]);
        if (req.method === 'GET') { lists.push(u.searchParams); return json({ data: Array.from({ length: 30 }, (_, i) => ({ id: i % 3 ? `e${i}` : `-x${i}` })), current_page: 1, last_page: 1, total: 30 }); }
        if (req.method === 'DELETE') { deleted.push(decodeURIComponent(u.pathname.split('/').pop()!)); return json({ ok: true }); }
        res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"route not found"}'); // no bulk route: an older server
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const root = await setup(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
        const dry = await runEf(root, ['crm', 'entries', 'purge', 'leads', '--q', 'old', '--dry-run']);
        assert.equal(dry.code, 0, dry.stderr);
        assert.match(dry.stderr, /Would delete 30 entries of leads matching the filters/);
        assert.equal(lists[0].get('q'), 'old');
        const no = await runEf(root, ['crm', 'entries', 'purge', 'leads']);
        assert.notEqual(no.code, 0);
        assert.match(no.stderr, /--yes/);
        assert.equal(deleted.length, 0);
        const yes = await runEf(root, ['crm', 'entries', 'purge', 'leads', '--yes', '--json']);
        assert.equal(yes.code, 0, yes.stderr);
        assert.equal(JSON.parse(yes.stdout).deleted, 30);
        assert.equal(new Set(deleted).size, 30);
        assert.ok(deleted.includes('-x0'));
    } finally { await new Promise<void>((r) => server.close(() => r())); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('entries purge uses bulk-delete in chunks of 500 when the server has it', async () => {
    const bulkCalls: string[][] = []; let singles = 0;
    const server = http.createServer((req, res) => {
        let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
            const u = new URL(req.url || '/', 'http://x');
            const json = (p: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
            if (req.method === 'GET') {
                const page = parseInt(u.searchParams.get('page') || '1', 10);
                const data = Array.from({ length: 100 }, (_, i) => ({ id: `e${(page - 1) * 100 + i}` })).filter((_, i) => (page - 1) * 100 + i < 1200);
                return json({ data, current_page: page, last_page: 12, total: 1200 });
            }
            if (req.method === 'POST' && u.pathname.endsWith('/entries/bulk-delete')) { const ids = JSON.parse(b).ids as string[]; bulkCalls.push(ids); return json({ deleted: ids.length }); }
            if (req.method === 'DELETE') { singles++; return json({}); }
            json({});
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const root = await setup(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
        const r = await runEf(root, ['crm', 'entries', 'purge', '5', '--yes', '--json']);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).deleted, 1200);
        assert.deepEqual(bulkCalls.map((c) => c.length), [500, 500, 200]);
        assert.equal(singles, 0);
    } finally { await new Promise<void>((r) => server.close(() => r())); await fs.promises.rm(root, { recursive: true, force: true }); }
});
