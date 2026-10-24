import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { listParams, stripDetailPii } from '../src/commands/contacts';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

// Invented people (example.test is reserved).
const PID = '01JCT360AAAAAAAAAAAAAAAAAA';
const MERGED = '01JCT360BBBBBBBBBBBBBBBBBB';
const ROW = {
    public_id: PID, lifecycle: 'customer', email_status: 'subscribed', sms_status: 'unknown', tags: ['vip'],
    customer_email: 'ana@example.test', customer_name: 'Ana Pop', customer_first_name: 'Ana', customer_last_name: 'Pop',
    customer_phone: '+14155550101', customer_country: 'US', customer_city: 'Austin', customer_postal_code: '73301',
    customer_state: 'Texas', last_order: { id: 9, customer_email: 'ana@example.test', shipping_address1: '1 Elm St' },
    total_orders: 2, lifetime_value: 154.5, created_at: '2026-10-01T10:00:00Z',
};
const DETAIL = {
    public_id: PID, lifecycle: 'customer', email: 'ana@example.test', phone: '+14155550101', first_name: 'Ana', last_name: 'Pop',
    postal_code: '73301', city: 'Austin', state: 'Texas', country: 'US',
    addresses: [{ kind: 'shipping', address1: '1 Elm St', zip: '73301', country: 'US' }], email_status: 'subscribed', sms_status: 'unknown', orders_count: 2,
    purchases_total: 154.5, currency_code: 'USD', tags: ['vip'], profile_id: 'prof-1',
    emails: [{ email: 'ana@example.test', is_primary: true, source: 'checkout' }],
    phones: [{ phone: '+14155550101', is_primary: true, source: 'checkout' }],
    consent: [{ channel: 'email', address: 'ana@example.test', status: 'opted_in', source: 'form', occurred_at: '2026-10-01T10:00:00Z' }],
    merges: [{ id: 3, absorbed_email: 'ana2@example.test' }],
    can_view_pii: true,
};
const PII = ['ana@example.test', 'Ana', 'Pop', '5550101', '73301', 'Austin', 'ana2@example.test', 'Texas', '1 Elm St'];

interface Mock { url: string; close: () => Promise<void>; requests: { path: string; query: URLSearchParams }[] }

function startMock(opts: { notEnabled?: boolean; rows?: number } = {}): Promise<Mock> {
    const requests: Mock['requests'] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url || '/', 'http://x');
            requests.push({ path: `${req.method} ${u.pathname}`, query: u.searchParams });
            const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
            if (opts.notEnabled && /\/contacts/.test(u.pathname)) return json(404, { error: 'contacts_not_enabled', phase: 'es' });
            if (/\/api\/brands\/7\/contacts$/.test(u.pathname)) {
                const n = opts.rows ?? 1;
                const perPage = Number(u.searchParams.get('per_page') || 20);
                const page = Number(u.searchParams.get('page') || 1);
                const all = Array.from({ length: n }, (_, i) => ({ ...ROW, public_id: i === 0 ? PID : `01JCT360${String(i).padStart(18, 'C')}` }));
                const data = all.slice((page - 1) * perPage, page * perPage);
                return json(200, { data, total: n, per_page: perPage, current_page: page, last_page: Math.max(1, Math.ceil(n / perPage)), source: 'mysql', can_view_pii: true });
            }
            if (u.pathname === `/api/brands/7/contacts/${PID}`) return json(200, { contact: DETAIL });
            if (u.pathname === `/api/brands/7/contacts/${MERGED}`) return json(200, { redirect_public_id: PID, contact: DETAIL });
            if (/\/contacts\//.test(u.pathname)) return json(404, { message: 'contact_not_found' });
            json(200, {});
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), requests });
        });
    });
}

async function setupProject(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-contacts-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return root;
}

function runEf(cwd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        if (input != null) { child.stdin.write(input); child.stdin.end(); }
    });
}

async function withMock(opts: Parameters<typeof startMock>[0], fn: (root: string, mock: Mock) => Promise<void>): Promise<void> {
    const mock = await startMock(opts);
    const root = await setupProject(mock.url);
    try { await fn(root, mock); } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
}

function assertNoPii(text: string): void {
    for (const s of PII) assert.ok(!text.includes(s), `output leaked "${s}"`);
}

test('contacts list --json drops personal data by default', () => withMock({}, async (root, mock) => {
    const r = await runEf(root, ['contacts', 'list', '--json', '--lifecycle', 'customer']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.total, 1);
    assert.equal(body.pii, false);
    assert.equal(body.contacts[0].public_id, PID);
    assert.equal(body.contacts[0].lifetime_value, 154.5);
    assert.equal(body.contacts[0].customer_country, 'US');
    assertNoPii(r.stdout);
    const req = mock.requests.find(x => x.path === 'GET /api/brands/7/contacts')!;
    assert.equal(req.query.get('lifecycle'), 'customer');
}));

test('contacts list --json --include-pii keeps what the server sent', () => withMock({}, async (root) => {
    const r = await runEf(root, ['contacts', 'list', '--json', '--include-pii']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).contacts[0].customer_email, 'ana@example.test');
}));

test('contacts list table never prints personal data; --include-pii without --json is refused', () => withMock({}, async (root) => {
    const r = await runEf(root, ['contacts', 'list']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.ok(r.stdout.includes(PID));
    assertNoPii(r.stdout + r.stderr);
    const bad = await runEf(root, ['contacts', 'list', '--include-pii']);
    assert.equal(bad.code, 2);
}));

test('contacts search sends q; --all pages through', () => withMock({ rows: 150 }, async (root, mock) => {
    const r = await runEf(root, ['contacts', 'search', 'ana@', '--all', '--json']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.count, 150);
    const reqs = mock.requests.filter(x => x.path === 'GET /api/brands/7/contacts');
    assert.equal(reqs.length, 2);
    assert.ok(reqs.every(x => x.query.get('q') === 'ana@'));
    assert.deepEqual(reqs.map(x => x.query.get('page')), ['1', '2']);
}));

test('contacts get --json strips PII and keeps consent statuses', () => withMock({}, async (root) => {
    const r = await runEf(root, ['contacts', 'get', PID, '--json']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.contact.public_id, PID);
    assert.equal(body.contact.emails_count, 1);
    assert.deepEqual(body.contact.consent, [{ channel: 'email', status: 'opted_in', source: 'form', occurred_at: '2026-10-01T10:00:00Z' }]);
    assertNoPii(r.stdout);

    const full = await runEf(root, ['contacts', 'get', PID, '--json', '--include-pii']);
    assert.equal(JSON.parse(full.stdout).contact.email, 'ana@example.test');
}));

test('contacts get follows a merged id and validates the id', () => withMock({}, async (root) => {
    const r = await runEf(root, ['contacts', 'get', MERGED, '--json']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).redirect_public_id, PID);

    const bad = await runEf(root, ['contacts', 'get', 'nope']);
    assert.equal(bad.code, 2);
    const missing = await runEf(root, ['contacts', 'get', '01JCT360ZZZZZZZZZZZZZZZZZZ']);
    assert.equal(missing.code, 7);
}));

test('a brand still on the old Customers report gets a clear not-enabled error', () => withMock({ notEnabled: true }, async (root) => {
    const r = await runEf(root, ['contacts', 'list', '--json']);
    assert.equal(r.code, 7);
    assert.match(r.stderr + r.stdout, /not enabled for this brand/);
}));

test('ef mcp offers contact tools that return the server values', () => withMock({}, async (root) => {
    const lines = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ef_search_contacts', arguments: { query: 'ana', limit: 5 } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ef_get_contact', arguments: { public_id: PID } } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n';
    const r = await runEf(root, ['mcp', '--project', root], lines);
    const replies = r.stdout.trim().split('\n').map(l => JSON.parse(l));
    const names = replies.find(x => x.id === 1).result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('ef_search_contacts') && names.includes('ef_get_contact'));
    const searchText = replies.find(x => x.id === 2).result.content[0].text;
    const search = JSON.parse(searchText);
    assert.equal(search.contacts[0].public_id, PID);
    assert.equal(search.contacts[0].total_orders, 2);
    assert.equal(search.can_view_pii, true);
    const getText = replies.find(x => x.id === 3).result.content[0].text;
    const get = JSON.parse(getText);
    assert.equal(get.contact.public_id, PID);
    assert.equal(get.contact.emails_count, 1);
    // security review 2026-10-21 T12: no PII to the agent unless it asks with include_pii
    assertNoPii(searchText);
    assertNoPii(getText);
}));

test('ef mcp contact tools return PII only with include_pii: true', () => withMock({}, async (root) => {
    const lines = [
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ef_search_contacts', arguments: { query: 'ana', include_pii: true } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ef_get_contact', arguments: { public_id: PID, include_pii: true } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ef_get_contact', arguments: { public_id: PID, include_pii: 'yes' } } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n';
    const r = await runEf(root, ['mcp', '--project', root], lines);
    const replies = r.stdout.trim().split('\n').map(l => JSON.parse(l));
    const search = JSON.parse(replies.find(x => x.id === 2).result.content[0].text);
    assert.equal(search.contacts[0].email, 'ana@example.test');
    assert.equal(search.contacts[0].name, 'Ana Pop');
    const get = JSON.parse(replies.find(x => x.id === 3).result.content[0].text);
    assert.equal(get.contact.email, 'ana@example.test');
    assertNoPii(replies.find(x => x.id === 4).result.content[0].text);
}));

test('listParams validates enums', () => {
    assert.deepEqual(listParams({ lifecycle: 'LEAD', emailStatus: 'subscribed', q: ' x ' }), { lifecycle: 'lead', email_status: 'subscribed', q: 'x' });
    assert.deepEqual(listParams({ phone: '+1 (415) 555-0101' }), { phone: '14155550101' });
    assert.throws(() => listParams({ sort: 'random' }), /--sort must be one of/);
});

test('stripDetailPii removes every personal field', () => {
    const out = JSON.stringify(stripDetailPii(DETAIL as never));
    assertNoPii(out);
    assert.ok(!out.includes('prof-1'));
});
