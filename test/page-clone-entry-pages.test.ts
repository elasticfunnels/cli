import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { parseAffiliateFlag } from '../src/commands/shared';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Req { method: string; url: string; body: Record<string, unknown> | null }

const PAGES = [
    { id: 501, slug: 'offer', title: 'Offer', status: 'published', is_active_version: true },
    { id: 502, slug: 'offer-b', title: 'Offer B', status: 'published', is_active_version: true },
    { id: 503, slug: 'order', title: 'Order', status: 'published', is_active_version: true, is_checkout_page: true },
];
/** A visual-builder page: only in the all-types list, as on the app. */
const BUILDER = { id: 504, slug: 'builder-page', title: 'Builder', status: 'published', is_active_version: true };

/** Answers like PagesController::clonePage and FunnelEntryPagesController on the app. */
function startMock(): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
    const requests: Req[] = [];
    const entry = new Set<number>([501]);
    const affiliates: Record<number, number | null> = {};
    const describe = () => [...entry].map((id) => ({ ...PAGES.find((p) => p.id === id)!, affiliate_id: affiliates[id] ?? null }));
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (d) => (raw += d));
            req.on('end', () => {
                let body: Record<string, unknown> | null = null;
                try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
                const url = req.url || '';
                requests.push({ method: req.method || '', url, body });
                const json = (p: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
                const p = url.split('?')[0];
                if (req.method === 'GET' && p === '/api/brands/7/pages/all') return json(url.includes('type=editor') ? PAGES : [...PAGES, BUILDER]);
                if (req.method === 'GET' && p === '/api/brands/7/funnels/all') return json([{ id: 9, code: 'main', title: 'Main' }]);
                if (req.method === 'POST' && p === '/api/brands/7/pages/501/clone') {
                    if (body?.slug === 'taken') return json({ message: 'The slug has already been taken.', errors: { slug: ['The slug has already been taken.'] } }, 422);
                    return json({ page_id: 777, slug: (body?.slug as string) ?? 'offer-copy' });
                }
                if (req.method === 'POST' && p === '/api/brands/7/pages/504/clone') return json({ page_id: 778, slug: 'builder-page-copy' });
                if (req.method === 'POST' && p === '/api/brands/7/pages/502/clone') {
                    return json({ error: 'Cannot clone a page variant. Please clone the main page or create a new variant instead.' }, 400);
                }
                if (p === '/api/brands/7/funnels/9/entry-pages' && req.method === 'GET') return json({ entry_pages: describe() });
                if (p === '/api/brands/7/funnels/9/entry-pages' && req.method === 'POST') {
                    const id = Number(body?.page_id);
                    if (id === 503) return json({ message: 'Checkout pages cannot be entry pages.', errors: { page_id: ['Checkout pages cannot be entry pages.'] } }, 422);
                    const changed = !entry.has(id); entry.add(id);
                    if (body && 'affiliate_id' in body) affiliates[id] = body.affiliate_id as number | null;
                    return json({ changed, entry_pages: describe() });
                }
                const m = p.match(/^\/api\/brands\/7\/funnels\/9\/entry-pages\/(\d+)$/);
                if (m && req.method === 'DELETE') {
                    const id = Number(m[1]);
                    if (entry.size === 1 && entry.has(id)) return json({ message: 'A funnel needs at least one entry page.', errors: { page_id: ['A funnel needs at least one entry page.'] } }, 422);
                    const changed = entry.delete(id);
                    return json({ changed, entry_pages: describe() });
                }
                if (req.method === 'PUT' && p === '/api/brands/7/pages/501') return json({ page: { ...PAGES[0], ...(body ?? {}) } });
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
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-clone-entry-'));
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

test('parseAffiliateFlag: id, none, rejects junk', () => {
    assert.equal(parseAffiliateFlag('412'), 412);
    assert.equal(parseAffiliateFlag('none'), null);
    assert.throws(() => parseAffiliateFlag('abc'), /numeric affiliate id/);
    assert.throws(() => parseAffiliateFlag('0'), /numeric affiliate id/);
});

test('pages duplicate: posts to /clone with options and reads { page_id, slug }', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const r = await runEf(root, ['pages', 'duplicate', 'offer', '--slug', 'offer-agency-a', '--title', 'Offer A', '--with-events', '--json']);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), { ok: true, page: { id: 777, slug: 'offer-agency-a' } });
        const post = mock.requests.find((q) => q.method === 'POST');
        assert.equal(post?.url, '/api/brands/7/pages/501/clone');
        assert.deepEqual(post?.body, { title: 'Offer A', slug: 'offer-agency-a', clone_with_page_events: true });
        assert.ok(!mock.requests.some((q) => q.url.includes('/duplicate')));

        const alias = await runEf(root, ['pages', 'clone', 'offer']);
        assert.equal(alias.code, 0, alias.stderr);
        assert.match(alias.stdout + alias.stderr, /#777 \(offer-copy\)/);

        const builder = await runEf(root, ['pages', 'duplicate', 'builder-page', '--json']);
        assert.equal(builder.code, 0, builder.stderr);
        assert.equal(JSON.parse(builder.stdout).page.id, 778);
    } finally { await mock.close(); }
});

test('pages duplicate: a taken slug is a validation error, a variant shows the server message', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const taken = await runEf(root, ['pages', 'duplicate', 'offer', '--slug', 'taken']);
        assert.equal(taken.code, 2);
        assert.match(taken.stderr, /already been taken/);
        const variant = await runEf(root, ['pages', 'duplicate', 'offer-b']);
        assert.equal(variant.code, 2);
        assert.match(variant.stderr, /Cannot clone a page variant/);
    } finally { await mock.close(); }
});

test('funnels pages: list, add with affiliate, add again is a no-op, remove, last page refused', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const list = await runEf(root, ['funnels', 'pages', 'list', 'main', '--json']);
        assert.equal(list.code, 0, list.stderr);
        assert.deepEqual(JSON.parse(list.stdout).entry_pages.map((p: { id: number }) => p.id), [501]);

        const add = await runEf(root, ['funnels', 'pages', 'add', 'main', 'offer-b', '--affiliate', '412', '--json']);
        assert.equal(add.code, 0, add.stderr);
        const added = JSON.parse(add.stdout);
        assert.equal(added.changed, true);
        assert.equal(added.entry_pages.find((p: { id: number }) => p.id === 502).affiliate_id, 412);
        assert.deepEqual(mock.requests.filter((q) => q.method === 'POST').at(-1)?.body, { page_id: 502, affiliate_id: 412 });

        const again = await runEf(root, ['funnels', 'pages', 'add', 'main', '502']);
        assert.equal(again.code, 0, again.stderr);
        assert.match(again.stdout + again.stderr, /already an entry page/);
        assert.deepEqual(mock.requests.filter((q) => q.method === 'POST').at(-1)?.body, { page_id: 502 });

        const checkout = await runEf(root, ['funnels', 'pages', 'add', 'main', 'order']);
        assert.equal(checkout.code, 2);
        assert.match(checkout.stderr, /Checkout pages cannot be entry pages/);

        const rm = await runEf(root, ['funnels', 'pages', 'remove', 'main', 'offer', '--json']);
        assert.equal(rm.code, 0, rm.stderr);
        assert.deepEqual(JSON.parse(rm.stdout).entry_pages.map((p: { id: number }) => p.id), [502]);
        assert.equal(mock.requests.filter((q) => q.method === 'DELETE').at(-1)?.url, '/api/brands/7/funnels/9/entry-pages/501');

        const last = await runEf(root, ['funnels', 'pages', 'rm', 'main', '502']);
        assert.equal(last.code, 2);
        assert.match(last.stderr, /at least one entry page/);
    } finally { await mock.close(); }
});

test('pages settings --affiliate sends affiliate_id; none clears it', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const set = await runEf(root, ['pages', 'settings', 'offer', '--affiliate', '412', '--json']);
        assert.equal(set.code, 0, set.stderr);
        assert.equal(mock.requests.filter((q) => q.method === 'PUT').at(-1)?.body?.affiliate_id, 412);
        const clear = await runEf(root, ['pages', 'settings', 'offer', '--affiliate', 'none', '--json']);
        assert.equal(clear.code, 0, clear.stderr);
        assert.equal(mock.requests.filter((q) => q.method === 'PUT').at(-1)?.body?.affiliate_id, '');
    } finally { await mock.close(); }
});
