import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { buildFunnelUpdatePayload } from '../src/commands/funnels';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Req { method: string; url: string; body: Record<string, unknown> | null; }
interface PageRow { id: number; slug: string; title: string; page_type: string; is_checkout_page: boolean; is_upsell_page: boolean; }
interface Mock {
    url: string;
    close: () => Promise<void>;
    requests: Req[];
    pages: Map<number, PageRow>;
    funnel: Record<string, unknown>;
    setAllowCheckouts: (v: boolean) => void;
}

const FUNNEL_RULES = { match: 'any', conditions: [{ field: 'query.src', operator: 'eq', value: 'fb' }] };

/**
 * Stands in for the brand API. Enforces what the server enforces for these two
 * routes: UpdatePage's allow_checkouts check on is_checkout_page, and
 * SaveFunnel's "checkout_page_id must be a checkout page". The funnel PUT
 * replaces domains/rules like FunnelsController::update does, so a payload
 * that leaves them out visibly wipes them.
 */
function startMock(): Promise<Mock> {
    let allowCheckouts = true;
    const requests: Req[] = [];
    const pages = new Map<number, PageRow>([
        [42, { id: 42, slug: 'order-form', title: 'Order Form', page_type: 'editor', is_checkout_page: false, is_upsell_page: false }],
        [50, { id: 50, slug: 'plain', title: 'Plain', page_type: 'editor', is_checkout_page: false, is_upsell_page: false }],
        [77, { id: 77, slug: 'builder-checkout', title: 'Builder Checkout', page_type: 'builder', is_checkout_page: true, is_upsell_page: false }],
    ]);
    const funnel: Record<string, unknown> = {
        id: 5, code: 'main', title: 'Main Funnel', status: 'active', checkout_page_id: null,
        rules: FUNNEL_RULES,
        domains: [
            { id: 900, brand_id: 7, domain_id: 11, funnel_id: 5, is_default: 1, cb_funnel_id: 'CB-1', cb_template_code: 'tpl', ds24_template_id: null, jvz_funnel_id: null },
            { id: 901, brand_id: 7, domain_id: 12, funnel_id: 5, is_default: 0, cb_funnel_id: null, cb_template_code: null, ds24_template_id: '88', jvz_funnel_id: null },
        ],
        domain: { id: 11, domain: 'shop.example.com' },
        trigger_pages: [3, 4],
    };
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (d) => (raw += d));
            req.on('end', () => {
                const [url, query = ''] = (req.url || '').split('?');
                let body: Record<string, unknown> | null = null;
                try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
                requests.push({ method: req.method || '', url: req.url || '', body });
                const json = (p: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
                const listed = (row: PageRow) => ({ id: row.id, slug: row.slug, variant_slug: null, title: row.title, page_type: row.page_type, is_active_version: true, updated_at: '2026-01-01T00:00:00Z' });

                if (req.method === 'GET' && /\/pages\/all$/.test(url)) {
                    const editorOnly = /type=editor/.test(query);
                    return json([...pages.values()].filter((p) => !editorOnly || p.page_type === 'editor').map(listed));
                }
                let m = /\/pages\/(\d+)\/editor$/.exec(url);
                if (req.method === 'GET' && m) {
                    const row = pages.get(Number(m[1]));
                    return row ? json({ ...listed(row), html: '' }) : json({ message: 'nope' }, 404);
                }
                m = /\/pages\/(\d+)\/live-url$/.exec(url);
                if (m) return json({ url: null });
                m = /\/pages\/(\d+)$/.exec(url);
                if (m) {
                    const row = pages.get(Number(m[1]));
                    if (!row) return json({ message: 'not found' }, 404);
                    if (req.method === 'GET') return json({ ...listed(row), status: 'published', is_checkout_page: row.is_checkout_page, is_upsell_page: row.is_upsell_page });
                    if (req.method === 'PUT') {
                        if (body?.is_checkout_page && !allowCheckouts) {
                            const msg = 'Checkout pages are not allowed for this brand. Enable checkouts in brand settings first.';
                            return json({ message: msg, errors: { is_checkout_page: [msg] } }, 422);
                        }
                        if (typeof body?.is_checkout_page === 'boolean') row.is_checkout_page = body.is_checkout_page;
                        if (typeof body?.is_upsell_page === 'boolean') row.is_upsell_page = body.is_upsell_page;
                        return json({ ...listed(row), is_checkout_page: row.is_checkout_page, is_upsell_page: row.is_upsell_page });
                    }
                }

                if (req.method === 'GET' && /\/funnels\/all$/.test(url)) return json([{ id: 5, code: 'main', title: 'Main Funnel', domain_id: null }]);
                if (/\/funnels\/5$/.test(url)) {
                    if (req.method === 'GET') return json(funnel);
                    if (req.method === 'PUT') {
                        const cp = body?.checkout_page_id;
                        if (cp != null && !pages.get(Number(cp))?.is_checkout_page) {
                            return json({ message: 'The selected checkout page id is invalid.', errors: { checkout_page_id: ['The selected checkout page id is invalid.'] } }, 422);
                        }
                        if (!body?.title) return json({ message: 'The title field is required.', errors: { title: ['The title field is required.'] } }, 422);
                        // Not a partial update: absent rules become null, domains are replaced.
                        funnel.title = body.title;
                        if (body.status) funnel.status = body.status;
                        funnel.rules = body.rules ?? null;
                        if (Array.isArray(body.domains)) funnel.domains = body.domains;
                        if ('checkout_page_id' in body) funnel.checkout_page_id = body.checkout_page_id;
                        return json(funnel);
                    }
                }
                json({});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                close: () => new Promise<void>((r) => server.close(() => r())),
                requests, pages, funnel,
                setAllowCheckouts: (v) => { allowCheckouts = v; },
            });
        });
    });
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-checkout-'));
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

const puts = (mock: Mock, re: RegExp) => mock.requests.filter((r) => r.method === 'PUT' && re.test(r.url));

test('pages settings --checkout-page sends is_checkout_page, and pages get reflects it', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['pages', 'settings', 'order-form', '--checkout-page', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.deepEqual(puts(mock, /\/pages\/42$/).map((q) => q.body), [{ is_checkout_page: true, title: 'Order Form' }]);
        assert.equal(JSON.parse(r.stdout).checkoutPage, true);

        const got = await runEf(root, ['pages', 'get', 'order-form', '--json']);
        assert.equal(got.code, 0, `stderr=${got.stderr}`);
        assert.equal(JSON.parse(got.stdout).page.is_checkout_page, true);
        const human = await runEf(root, ['pages', 'get', 'order-form']);
        assert.match(human.stdout, /Checkout page\s+yes/);

        assert.equal((await runEf(root, ['pages', 'settings', 'order-form', '--no-checkout-page', '--upsell-page', '--json'])).code, 0);
        assert.deepEqual(puts(mock, /\/pages\/42$/).at(-1)?.body, { is_checkout_page: false, is_upsell_page: true, title: 'Order Form' });
        assert.match((await runEf(root, ['pages', 'get', 'order-form'])).stdout, /Checkout page\s+no/);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('pages settings --checkout-page surfaces the server 422 (brand without checkouts) with exit 2', async () => {
    const mock = await startMock();
    mock.setAllowCheckouts(false);
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['pages', 'settings', 'order-form', '--checkout-page']);
        assert.equal(r.code, 2, `stderr=${r.stderr}`);
        assert.match(r.stderr, /is_checkout_page: Checkout pages are not allowed for this brand\. Enable checkouts in brand settings first\./);
        assert.match(r.stderr, /HTTP 422/);
        assert.equal(mock.pages.get(42)?.is_checkout_page, false);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('pages settings finds a builder page by slug (not in the editor-only listing)', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['pages', 'settings', 'builder-checkout', '--no-checkout-page', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.deepEqual(puts(mock, /\/pages\/77$/).map((q) => q.body), [{ is_checkout_page: false, title: 'Builder Checkout' }]);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('funnels settings --checkout-page resends every current field and changes only checkout_page_id', async () => {
    const mock = await startMock();
    mock.pages.get(42)!.is_checkout_page = true;
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['funnels', 'settings', 'main', '--checkout-page', 'order-form', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const sent = puts(mock, /\/funnels\/5$/);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].body, {
            title: 'Main Funnel',
            status: 'active',
            rules: FUNNEL_RULES,
            domains: [
                { domain_id: 11, is_default: true, cb_funnel_id: 'CB-1', cb_template_code: 'tpl', ds24_template_id: null, jvz_funnel_id: null },
                { domain_id: 12, is_default: false, cb_funnel_id: null, cb_template_code: null, ds24_template_id: '88', jvz_funnel_id: null },
            ],
            checkout_page_id: 42,
        });
        assert.equal('trigger_pages' in (sent[0].body ?? {}), false, 'trigger_pages is never sent (it would rewrite the builder graph)');
        assert.deepEqual(JSON.parse(r.stdout), { ok: true, funnel: { id: 5, code: 'main' }, checkout_page_id: 42, previous_checkout_page_id: null });
        // The funnel read with the compiled flow left out.
        assert.ok(mock.requests.some((q) => q.method === 'GET' && /\/funnels\/5\?flow=0$/.test(q.url)));

        // The mock applied the PUT like the real controller: nothing else moved.
        assert.deepEqual(mock.funnel.rules, FUNNEL_RULES);
        assert.equal((mock.funnel.domains as unknown[]).length, 2);

        const got = JSON.parse((await runEf(root, ['funnels', 'get', 'main', '--json'])).stdout);
        assert.equal(got.funnel.checkout_page_id, 42);
        assert.equal(got.funnel.checkout_page.slug, 'order-form');
        const human = await runEf(root, ['funnels', 'get', 'main']);
        assert.match(human.stdout, /Checkout page\s+\/order-form #42/);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('funnels settings --checkout-page none clears it; a builder checkout page resolves by slug', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        assert.equal((await runEf(root, ['funnels', 'settings', '5', '--checkout-page', 'builder-checkout'])).code, 0);
        assert.equal(puts(mock, /\/funnels\/5$/).at(-1)?.body?.checkout_page_id, 77);
        const cleared = await runEf(root, ['funnels', 'settings', 'main', '--checkout-page', 'none', '--json']);
        assert.equal(cleared.code, 0, `stderr=${cleared.stderr}`);
        const body = puts(mock, /\/funnels\/5$/).at(-1)?.body;
        assert.equal(body?.checkout_page_id, null);
        assert.equal(body?.title, 'Main Funnel');
        assert.equal(JSON.parse(cleared.stdout).previous_checkout_page_id, 77);
        assert.match((await runEf(root, ['funnels', 'get', 'main'])).stdout, /Checkout page\s+none/);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('funnels settings refuses a page that is not a checkout page, and sends nothing', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['funnels', 'settings', 'main', '--checkout-page', 'plain']);
        assert.equal(r.code, 2, `stderr=${r.stderr}`);
        assert.match(r.stderr, /mark it first: ef pages settings plain --checkout-page/);
        assert.equal(puts(mock, /\/funnels\//).length, 0);

        const missing = await runEf(root, ['funnels', 'settings', 'main', '--checkout-page', 'no-such-page']);
        assert.equal(missing.code, 7);
        const nothing = await runEf(root, ['funnels', 'settings', 'main']);
        assert.equal(nothing.code, 2);
        assert.equal(puts(mock, /\/funnels\//).length, 0);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('buildFunnelUpdatePayload keeps a draft funnel draft, with no domains and null rules', () => {
    const body = buildFunnelUpdatePayload({ id: 9, title: 'Draft', status: 'draft', checkout_page_id: 4, rules: null, domains: [] }, {});
    assert.deepEqual(body, { title: 'Draft', status: 'draft', rules: null, domains: [], checkout_page_id: 4 });
    assert.equal(buildFunnelUpdatePayload({ id: 9, title: 'X', checkout_page_id: 4 }, { checkout_page_id: null }).checkout_page_id, null);
});
