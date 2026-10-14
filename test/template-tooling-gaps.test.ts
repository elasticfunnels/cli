import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { loginSettingFlags } from '../src/commands/pageCommands';
import { findProfile, matchProducts, mergeCosts, parseOverride, parseRate } from '../src/commands/shippingProfiles';
import { findTag } from '../src/commands/tags';
import { CliError, ExitCode } from '../src/utils/exit';

/**
 * Gaps found while building the template kits: members-only pages from flags,
 * shipping profiles from the CLI, and deleting collections/tags safely.
 */

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

function caught(fn: () => unknown): CliError {
    try { fn(); } catch (err) { assert.ok(err instanceof CliError, `expected a CliError, got ${err}`); return err; }
    throw new assert.AssertionError({ message: 'expected the call to throw' });
}

// ── pure helpers ─────────────────────────────────────────────────────

test('--requires-login on|off and --redirect-url map to the page fields', () => {
    assert.deepEqual(loginSettingFlags('on', '/account/login'), { requires_login: true, redirect_url: '/account/login' });
    assert.deepEqual(loginSettingFlags('OFF'), { requires_login: false });
    assert.deepEqual(loginSettingFlags(undefined, 'none'), { redirect_url: null });
    assert.deepEqual(loginSettingFlags(undefined, 'https://x.test/login'), { redirect_url: 'https://x.test/login' });
    assert.deepEqual(loginSettingFlags(), {});
});

test('a typo in --requires-login is refused, never read as off', () => {
    assert.equal(caught(() => loginSettingFlags('of')).code, ExitCode.Validation);
    assert.equal(caught(() => loginSettingFlags(undefined, 'javascript:alert(1)')).code, ExitCode.Validation);
    assert.equal(caught(() => loginSettingFlags(undefined, 'account/login')).code, ExitCode.Validation, 'a relative path without / is ambiguous');
});

test('rates: amounts, $ prefix, none = empty (free), negatives refused', () => {
    assert.equal(parseRate('--us', '6.95'), 6.95);
    assert.equal(parseRate('--us', '$4.49'), 4.49);
    assert.equal(parseRate('--us', '0'), 0);
    assert.equal(parseRate('--intl', 'none'), null);
    assert.equal(parseRate('--intl', 'free'), null);
    assert.equal(caught(() => parseRate('--us', '-1')).code, ExitCode.Validation);
    assert.equal(caught(() => parseRate('--us', 'abc')).code, ExitCode.Validation);
});

test('overrides parse as COUNTRY:amount', () => {
    assert.deepEqual(parseOverride('ca:9.95'), { country_code: 'CA', cost: 9.95 });
    assert.deepEqual(parseOverride('GB=$12'), { country_code: 'GB', cost: 12 });
    assert.equal(caught(() => parseOverride('Canada:9')).code, ExitCode.Validation);
});

test('an update keeps rates it was not given and replaces overrides by country', () => {
    const current = { us_mainland: '5.00', international: 14.95, overrides: [{ country_code: 'CA', cost: 9 }, { country_code: 'GB', cost: 11 }] };
    assert.deepEqual(mergeCosts(current, { us: '7.95', override: ['ca:10'], removeOverride: ['gb'] }), {
        us_mainland: 7.95, international: 14.95, overrides: [{ country_code: 'CA', cost: 10 }],
    });
    assert.deepEqual(mergeCosts(current, { clearOverrides: true }).overrides, []);
    assert.deepEqual(mergeCosts(null, { us: '6.95' }), { us_mainland: 6.95, international: null, overrides: [] });
});

test('profiles resolve by id, #id or name; ambiguous names are refused', () => {
    const rows = [{ id: 3, name: 'Single jar' }, { id: 4, name: 'Bundle' }, { id: 5, name: 'bundle' }];
    assert.equal(findProfile(rows, '#3')?.id, 3);
    assert.equal(findProfile(rows, 'single JAR')?.id, 3);
    assert.equal(findProfile(rows, 'nope'), null);
    assert.equal(caught(() => findProfile(rows, 'Bundle')).code, ExitCode.Validation);
});

test('products resolve by code or id, de-duplicated; every unknown one is named', () => {
    const all = [{ id: 1, code: 'GADGET-1', title: null }, { id: 2, code: 'GADGET-3', title: null }];
    assert.deepEqual(matchProducts(all, ['gadget-1', '1', '#2']).map((p) => p.id), [1, 2]);
    const err = caught(() => matchProducts(all, ['GADGET-1,NOPE', 'ALSO-NOPE']));
    assert.equal(err.code, ExitCode.NotFound);
    assert.match(err.message, /"NOPE", "ALSO-NOPE"/);
});

test('a tag id can be written #672', () => {
    const tags = [{ id: 672, name: 'kits', color: '#000' }, { id: 7, name: '672', color: '#000' }];
    assert.equal(findTag(tags as never, '#672')?.id, 672);
    assert.equal(findTag(tags as never, 'kits')?.id, 672);
});

// ── end to end against a fake server ─────────────────────────────────

interface Hit { method: string; url: string; body: Record<string, unknown> }

function startMock(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
    const hits: Hit[] = [];
    const profiles = [{ id: 9, name: 'Gadget 1-unit', shipping_costs: { us_mainland: 5, international: null, overrides: [] } }];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                const url = req.url || '';
                let body: Record<string, unknown> = {};
                try { body = JSON.parse(raw || '{}'); } catch { /* {} */ }
                hits.push({ method: req.method || '', url, body });
                const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
                if (req.method === 'GET' && /\/pages\/all/.test(url)) return send(200, [{ id: 42, slug: 'account', title: 'Account', is_active_version: true }]);
                if (req.method === 'PUT' && /\/pages\/42$/.test(url)) return send(200, { id: 42, slug: 'account', title: 'Account', ...body });
                if (req.method === 'GET' && /\/shipping-profiles\?/.test(url)) return send(200, { data: profiles, last_page: 1 });
                if (req.method === 'GET' && /\/shipping-profiles\/9$/.test(url)) return send(200, profiles[0]);
                if (req.method === 'PUT' && /\/shipping-profiles\/9$/.test(url)) return send(200, { ...profiles[0], ...body });
                if (req.method === 'POST' && /\/shipping-profiles$/.test(url)) return send(200, { profile: { id: 10, ...body } });
                if (req.method === 'GET' && /\/products\/all/.test(url)) return send(200, [{ id: 1, code: 'GADGET-1', shipping_profile_id: 9 }, { id: 2, code: 'GADGET-3', shipping_profile_id: null }]);
                if (req.method === 'POST' && /\/bulk-set-shipping-profile$/.test(url)) return send(200, { success: true, updated_count: (body.product_ids as unknown[]).length });
                if (req.method === 'GET' && /\/collections\/nrglvq$/.test(url)) return send(200, { id: 31, code: 'nrglvq', name: 'Old form', total_entries: 2 });
                if (req.method === 'DELETE' && /\/collections\/31$/.test(url)) return send(200, { success: true });
                if (req.method === 'GET' && /\/tags(\?|$)/.test(url)) return send(200, [{ id: 672, name: 'kits', color: '#000' }]);
                if (req.method === 'DELETE' && /\/tags\/672$/.test(url)) return send(200, { success: true });
                send(404, { message: 'not mocked' });
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, hits, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function project(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-gaps-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    await fs.promises.mkdir(path.join(root, 'elasticfunnels', 'pages'), { recursive: true });
    return root;
}

function runEf(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve) => {
        // stdin is a pipe here, i.e. not a TTY: what an agent or a script sees.
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', EF_NO_UPDATE_CHECK: '1' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
}

async function withMock(fn: (root: string, hits: Hit[]) => Promise<void>): Promise<void> {
    const mock = await startMock();
    const root = await project(mock.url);
    try { await fn(root, mock.hits); } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

test('ef pages settings --requires-login on --redirect-url sends both fields', () => withMock(async (root, hits) => {
    const res = await runEf(root, ['pages', 'settings', 'account', '--requires-login', 'on', '--redirect-url', '/account/login', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const put = hits.find((h) => h.method === 'PUT');
    assert.equal(put?.body.requires_login, true);
    assert.equal(put?.body.redirect_url, '/account/login');
    assert.equal(put?.body.title, 'Account', 'title resent: the server requires it');
}));

test('ef shipping-profiles create sends the rates the server expects', () => withMock(async (root, hits) => {
    const res = await runEf(root, ['shipping-profiles', 'create', 'Single jar', '--us', '6.95', '--intl', '14.95', '--override', 'CA:9.95', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const post = hits.find((h) => h.method === 'POST' && /shipping-profiles$/.test(h.url));
    assert.deepEqual(post?.body, { name: 'Single jar', shipping_costs: { us_mainland: 6.95, international: 14.95, overrides: [{ country_code: 'CA', cost: 9.95 }] } });
}));

test('ef shipping-profiles update changes one rate and keeps the others', () => withMock(async (root, hits) => {
    const res = await runEf(root, ['shipping-profiles', 'update', 'gadget 1-unit', '--us', '7.95', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const put = hits.find((h) => h.method === 'PUT');
    assert.deepEqual(put?.body.shipping_costs, { us_mainland: 7.95, international: null, overrides: [] });
    assert.equal(put?.body.name, 'Gadget 1-unit');
}));

test('ef shipping-profiles assign / --none', () => withMock(async (root, hits) => {
    let res = await runEf(root, ['shipping-profiles', 'assign', 'GADGET-1', '--profile', '9', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(hits.filter((h) => /bulk-set/.test(h.url)).pop()?.body, { product_ids: [1], shipping_profile_id: 9 });

    res = await runEf(root, ['shipping-profiles', 'assign', 'GADGET-1', 'GADGET-3', '--none', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(hits.filter((h) => /bulk-set/.test(h.url)).pop()?.body, { product_ids: [1, 2], shipping_profile_id: null });

    res = await runEf(root, ['shipping-profiles', 'assign', 'GADGET-1']);
    assert.equal(res.status, ExitCode.Validation, 'needs --profile or --none');
}));

test('ef shipping-profiles get lists the products on the profile', () => withMock(async (root) => {
    const res = await runEf(root, ['shipping-profiles', 'get', '9', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).products, [{ id: 1, code: 'GADGET-1' }]);
}));

test('ef collections delete: refused without --force off a terminal, deletes by id with it', () => withMock(async (root, hits) => {
    let res = await runEf(root, ['collections', 'delete', 'nrglvq']);
    assert.equal(res.status, ExitCode.Validation);
    assert.match(res.stderr + res.stdout, /--force/);
    assert.equal(hits.some((h) => h.method === 'DELETE'), false);

    res = await runEf(root, ['collections', 'delete', 'nrglvq', '--force', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(hits.some((h) => h.method === 'DELETE' && /\/collections\/31$/.test(h.url)), 'by numeric id: the route binds by id');
    assert.deepEqual(JSON.parse(res.stdout).deleted, { id: 31, code: 'nrglvq', name: 'Old form', entries: 2 });
}));

test('ef tags delete: refused without --force off a terminal; #id works', () => withMock(async (root, hits) => {
    let res = await runEf(root, ['tags', 'delete', '#672']);
    assert.equal(res.status, ExitCode.Validation);
    assert.equal(hits.some((h) => h.method === 'DELETE'), false);

    res = await runEf(root, ['tags', 'delete', '#672', '--force', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(hits.some((h) => h.method === 'DELETE' && /\/tags\/672$/.test(h.url)));
}));
