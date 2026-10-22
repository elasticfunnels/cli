import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { buildWhichUrl, renderWhich } from '../src/commands/funnelWhich';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Req { method: string; url: string; body: Record<string, unknown> | null }

/** A resolved verdict shaped like FunnelTriggerController@resolveTest's answer. */
const WON = {
    ok: true, resolved: true,
    domain: { id: 11, domain: 'shop.example.com' },
    page: { id: 501, title: 'Offer page', slug: 'offer' },
    context: { affiliate: '123', query: { aff: '123', utm_source: 'fb' } },
    explicit_funnel_param: null,
    winner: { id: 2, code: 'UK-AFF', title: 'UK affiliates' },
    won_via: 'trigger_override_won',
    trace: [
        { step: 'trigger_overrides', outcome: 'matched', funnel_id: 2, funnel_code: 'UK-AFF', conditions: [
            { field: 'affiliate', operator: 'in', value: 9001 }, { field: 'affiliate', operator: 'in', value: 9002 },
            { field: 'geo_country', operator: 'equals', value: 'GB' },
        ] },
        { step: 'trigger_overrides', outcome: 'skipped', reason: 'is_domain_default_overrides_never_evaluated', funnel_id: 1, funnel_code: 'MAIN' },
        { step: 'entry_pages', outcome: 'excluded', funnel_id: 3, funnel_code: 'BLOG' },
        { step: 'result', outcome: 'won', funnel_id: 2 },
    ],
    funnel_titles: { 1: 'Main funnel', 2: 'UK affiliates', 3: 'Blog \u001b]52;c;evil\u0007funnel' },
    next: {
        merchant: { id: 4, name: 'ClickBank main', gateway: 'clickbank', from_events: false },
        redirects_to: null, checkout: false,
        after_buy: [{ products: [{ code: 'P1', name: 'One bottle', price: 49 }], to: { kind: 'page', page_id: 502, title: 'Upsell 1', slug: 'up1', status: 'published' } }],
        after_decline: { kind: 'none' },
    },
};

function startMock(): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
    const requests: Req[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (d) => (raw += d));
            req.on('end', () => {
                let body: Record<string, unknown> | null = null;
                try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
                requests.push({ method: req.method || '', url: req.url || '', body });
                const json = (p: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
                if (req.method !== 'POST' || req.url !== '/api/brands/7/funnels/resolve-test') return json({ message: 'not found' }, 404);
                const target = new URL(String(body?.url));
                if (target.host === 'other.example.com') return json({ ok: false, error: 'foreign_domain', host: 'other.example.com' }, 422);
                if (target.pathname === '/missing') return json({ ok: true, resolved: false, reason: 'page_not_found', host: target.host, path: '/missing' });
                if (target.pathname === '/nofunnel') {
                    return json({ ...WON, winner: null, won_via: null, next: undefined, trace: [{ step: 'result', outcome: 'no_funnel', reason: 'no_domain_default' }] });
                }
                if (target.pathname === '/down') return json({ ok: false, error: 'runtime_unreachable' }, 502);
                json(WON);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-funnels-which-'));
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

test('buildWhichUrl: keeps the URL, appends --param pairs, rejects non-http', () => {
    assert.equal(buildWhichUrl('https://shop.example.com/offer?x=1', ['aff=123', 'utm_source=fb']), 'https://shop.example.com/offer?x=1&aff=123&utm_source=fb');
    assert.throws(() => buildWhichUrl('shop.example.com/offer'), /not a valid URL/);
    assert.throws(() => buildWhichUrl('ftp://shop.example.com/'), /Only http and https/);
    assert.throws(() => buildWhichUrl('https://shop.example.com/', ['novalue']), /key=value/);
});

test('funnels which: sends url + geo and prints the winner, why and what loads', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const r = await runEf(root, ['funnels', 'which', 'https://shop.example.com/offer', '--param', 'aff=123', '--country', 'gb', '--region', 'ENG']);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(mock.requests[0].body, { url: 'https://shop.example.com/offer?aff=123', country_code: 'GB', region: 'ENG' });
        const out = r.stdout;
        assert.match(out, /This URL runs UK affiliates code UK-AFF #2/);
        assert.match(out, /It won on a trigger override\./);
        assert.match(out, /Loads\s+shop\.example\.com\s+page Offer page \/offer #501/);
        assert.match(out, /affiliate 123 · aff=123 · utm_source=fb/);
        assert.match(out, /Merchant\s+ClickBank main \(clickbank\)/);
        assert.match(out, /One bottle \(P1\) → Upsell 1, \/up1/);
        assert.match(out, /No thanks → no next step/);
        assert.match(out, /UK affiliates \(UK-AFF\) matched its trigger override\./);
        assert.match(out, /Affiliate 123 is one of the 2 affiliate IDs/);
        assert.match(out, /Conditions: geo_country equals "GB"/);
        assert.match(out, /1 {2}Already the domain default.*Main funnel \(MAIN\)/);
        assert.match(out, /1 {2}This page is not one of their entry pages: Blog funnel/);
        assert.doesNotMatch(out, /\u001b|\u0007/, 'server strings are sanitized');
        assert.match(r.stderr, /ef funnels get UK-AFF/);
    } finally { await mock.close(); }
});

test('funnels which --json: prints the payload with the URL and visitor sent', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const r = await runEf(root, ['funnels', 'resolve', 'https://shop.example.com/offer?aff=123', '--json']);
        assert.equal(r.code, 0, r.stderr);
        const j = JSON.parse(r.stdout);
        assert.equal(j.url, 'https://shop.example.com/offer?aff=123');
        assert.equal(j.country_code, null);
        assert.equal(j.winner.code, 'UK-AFF');
        assert.equal(j.trace.length, 4);
        assert.equal(j.next.merchant.name, 'ClickBank main');
        assert.deepEqual(mock.requests[0].body, { url: 'https://shop.example.com/offer?aff=123', country_code: null, region: null });
    } finally { await mock.close(); }
});

test('funnels which: no winner is a valid answer and names the reason', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const r = await runEf(root, ['funnels', 'which', 'https://shop.example.com/nofunnel']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /No funnel would run for this URL\./);
        assert.match(r.stdout, /No default funnel is assigned to this domain\./);
    } finally { await mock.close(); }
});

test('funnels which: foreign domain (422), missing page, runtime down, bad input', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const foreign = await runEf(root, ['funnels', 'which', 'https://other.example.com/']);
        assert.equal(foreign.code, 2);
        assert.match(foreign.stderr, /other\.example\.com is not one of this brand's domains/);

        const missing = await runEf(root, ['funnels', 'which', 'https://shop.example.com/missing']);
        assert.equal(missing.code, 7);
        assert.match(missing.stderr, /No page is served at \/missing on shop\.example\.com/);
        const missingJson = await runEf(root, ['funnels', 'which', 'https://shop.example.com/missing', '--json']);
        assert.equal(missingJson.code, 7);
        assert.equal(JSON.parse(missingJson.stdout).reason, 'page_not_found');

        const down = await runEf(root, ['funnels', 'which', 'https://shop.example.com/down']);
        assert.equal(down.code, 6);
        assert.match(down.stderr, /could not reach the page runtime/);

        const before = mock.requests.length;
        const bad = await runEf(root, ['funnels', 'which', 'javascript:alert(1)']);
        assert.equal(bad.code, 2);
        const badCountry = await runEf(root, ['funnels', 'which', 'https://shop.example.com/', '--country', 'Britain']);
        assert.equal(badCountry.code, 2);
        assert.equal(mock.requests.length, before, 'invalid input never reaches the server');
    } finally { await mock.close(); }
});

test('funnels which: an app without the tester route (404) says so', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"Not Found"}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
        const root = await setup(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
        const r = await runEf(root, ['funnels', 'which', 'https://shop.example.com/offer']);
        assert.equal(r.code, 7);
        assert.match(r.stderr, /no "which funnel runs" tester/);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test('renderWhich: long ruled-out lists are capped with a pointer to --json', () => {
    const trace = Array.from({ length: 12 }, (_, i) => ({ step: 'entry_pages', outcome: 'excluded', funnel_id: 100 + i, funnel_code: `F${i}` }));
    const lines = renderWhich({ ok: true, resolved: true, winner: null, trace }, { listLimit: 3 }).join('\n');
    assert.match(lines, /12 {2}This page is not one of their entry pages: F0, F1, F2 \+9 more/);
});
