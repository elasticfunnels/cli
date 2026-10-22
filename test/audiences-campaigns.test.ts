import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { installBundledSkills } from '../src/commands/claude';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Call { method: string; path: string; query: string; body: Record<string, unknown> }
interface Mock { url: string; calls: Call[]; close: () => Promise<void> }

const SEGQL = 'FROM conversions WHERE HAS conversion(type = "purchase") WITHIN 30d IDENTIFY BY email';

/** A fake app: segments, email campaigns and SMS campaigns, enough for every command path. */
function startMock(): Promise<Mock> {
    const calls: Call[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (d) => (raw += d));
            req.on('end', () => {
                const [url, query = ''] = (req.url || '').split('?');
                let body: Record<string, unknown> = {};
                try { body = JSON.parse(raw); } catch { /* empty */ }
                const m = req.method ?? 'GET';
                calls.push({ method: m, path: url, query, body });
                const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };

                // ── segments
                if (m === 'POST' && url.endsWith('/analytics/segments/validate-segql')) {
                    return String(body.segql).startsWith('FROM nowhere')
                        ? json(400, { error: 'parse', message: "Expected token type 'IDENTIFIER'" })
                        : json(200, { valid: true, identity_column: 'email_hash' });
                }
                if (m === 'POST' && url.endsWith('/analytics/segments/preview-segql')) return json(200, { identity_column: 'email_hash', count: 42, samples: ['h1', 'h2'] });
                if (m === 'POST' && url.endsWith('/analytics/segments/compile-and-save-segql')) return json(201, { id: 31, name: body.name, segql: body.segql });
                if (m === 'GET' && url.endsWith('/analytics/segments')) return json(200, [{ id: 31, name: 'Buyers', identity_kind: 'email', member_count: 42, computed_at: null }]);
                if (m === 'GET' && /\/analytics\/segments\/31$/.test(url)) return json(200, { id: 31, name: 'Buyers', member_count: 42 });
                if (m === 'GET' && /\/analytics\/segments\/31\/members$/.test(url)) return json(200, { rows: [{ email: 'j***@g***.com', orders: 2 }], total: 42 });
                if (m === 'PUT' && /\/analytics\/segments\/31\/segql$/.test(url)) return json(200, { id: 31 });
                if (m === 'PUT' && /\/analytics\/segments\/31$/.test(url)) return json(200, { id: 31 });
                if (m === 'DELETE' && /\/analytics\/segments\/31$/.test(url)) return json(200, { ok: true });

                // ── email campaigns
                if (m === 'POST' && url.endsWith('/email-campaigns/preview-audience')) return json(200, { total: 50, eligible: 45, count: 45, excluded: { suppressed: 3, no_consent: 2, duplicates: 0 }, sample: [{ email: 'c***@b***.test', name: 'C***' }], exact: true });
                if (m === 'POST' && url.endsWith('/email-campaigns')) return json(200, { id: 17, campaign: { id: 17, email_id: 900, problems: ['no_content'] } });
                if (m === 'GET' && /\/email-campaigns\/17$/.test(url)) return json(200, { id: 17, name: 'Oct', email_id: 900, audience_type: 'analytics_segment', audience_config: { segment_id: 31 }, problems: [] });
                if (m === 'PUT' && /\/email-campaigns\/17$/.test(url)) return json(200, { id: 17, problems: [] });
                if (m === 'POST' && /\/emails\/900\/builder$/.test(url)) return json(200, { ok: true });
                if (m === 'POST' && /\/email-campaigns\/17\/send-test$/.test(url)) return json(200, { success: true, to: body.to, provider: 'log' });
                if (m === 'POST' && /\/email-campaigns\/17\/launch$/.test(url)) return json(200, { id: 17, status: 'queued', scheduled: !!body.schedule_at, schedule_at: body.schedule_at ?? null });
                if (m === 'POST' && /\/email-campaigns\/18\/launch$/.test(url)) return json(422, { code: 'test_required' });
                if (m === 'GET' && /\/email-campaigns\/18$/.test(url)) return json(200, { id: 18, audience_type: 'all_customers', problems: [] });

                // ── SMS campaigns
                if (m === 'POST' && url.endsWith('/sms/campaigns/preview-audience')) return json(200, { total: 12, reachable: 10, skips: { suppressed: 1, no_phone: 1 }, by_place: [] });
                if (m === 'POST' && url.endsWith('/sms/campaigns')) return json(201, { id: 9, name: body.name, status: 'draft' });
                if (m === 'PUT' && /\/sms\/campaigns\/9$/.test(url)) return json(200, { id: 9, status: 'draft', ...body });
                if (m === 'GET' && /\/sms\/campaigns\/9$/.test(url)) return json(200, { id: 9, name: 'Flash', status: 'draft', audience: { segment_ids: [31], exclude_segment_ids: [] }, exclude_regions: [] });
                if (m === 'POST' && /\/sms\/campaigns\/9\/preview$/.test(url)) return json(200, { rendered: 'Hi Jo. Reply STOP to opt out', chars: 28, segments: 1, encoding: 'GSM-7', warnings: [], blocks: [] });
                if (m === 'POST' && /\/sms\/campaigns\/9\/launch$/.test(url)) return json(200, { id: 9, status: 'sending' });

                json(404, { message: 'not mocked' });
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function setupProject(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-camp-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return root;
}

function runEf(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        // stdin is a pipe, never a TTY: exactly how an agent runs the CLI.
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.stdin.end();
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function withMock(fn: (mock: Mock, root: string) => Promise<void>): Promise<void> {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try { await fn(mock, root); } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

const hits = (mock: Mock, method: string, re: RegExp) => mock.calls.filter((c) => c.method === method && re.test(c.path));

test('audiences validate / count / create send the SegQL and report parse errors', async () => {
    await withMock(async (mock, root) => {
        const v = await runEf(root, ['audiences', 'validate', '--segql', SEGQL, '--json']);
        assert.equal(v.code, 0, v.stderr);
        assert.deepEqual(JSON.parse(v.stdout), { valid: true, identity_column: 'email_hash' });
        assert.equal(hits(mock, 'POST', /\/api\/brands\/7\/analytics\/segments\/validate-segql$/)[0].body.segql, SEGQL);

        const bad = await runEf(root, ['audiences', 'validate', '--segql', 'FROM nowhere WHERE']);
        assert.equal(bad.code, 2);
        assert.match(bad.stderr, /SegQL parse error: Expected token/);

        const file = path.join(root, 'aud.segql');
        await fs.promises.writeFile(file, SEGQL + '\n');
        const c = await runEf(root, ['audiences', 'count', '--file', file, '--sample', '5']);
        assert.equal(c.code, 0, c.stderr);
        assert.match(c.stderr, /42 people match/);
        assert.equal(hits(mock, 'POST', /preview-segql$/)[0].body.sample_size, 5);

        const cr = await runEf(root, ['audiences', 'create', '--name', 'Buyers', '--file', file, '--json']);
        assert.equal(cr.code, 0, cr.stderr);
        assert.deepEqual(hits(mock, 'POST', /compile-and-save-segql$/)[0].body, { name: 'Buyers', segql: SEGQL });

        const none = await runEf(root, ['audiences', 'create', '--name', 'X']);
        assert.equal(none.code, 2);
        assert.match(none.stderr, /SegQL definition is required/);
    });
});

test('audiences count by id reads the saved size and masked members; update picks the right route; delete needs --yes', async () => {
    await withMock(async (mock, root) => {
        const c = await runEf(root, ['audiences', 'count', '31', '--json']);
        assert.equal(c.code, 0, c.stderr);
        const out = JSON.parse(c.stdout);
        assert.equal(out.count, 42);
        assert.equal(out.members.rows[0].email, 'j***@g***.com');

        assert.equal((await runEf(root, ['audiences', 'update', '31', '--name', 'Renamed'])).code, 0);
        assert.deepEqual(hits(mock, 'PUT', /\/segments\/31$/)[0].body, { name: 'Renamed' });
        assert.equal((await runEf(root, ['audiences', 'update', '31', '--segql', SEGQL])).code, 0);
        assert.equal(hits(mock, 'PUT', /\/segments\/31\/segql$/)[0].body.segql, SEGQL);

        const del = await runEf(root, ['audiences', 'delete', '31']);
        assert.equal(del.code, 2);
        assert.match(del.stderr, /--yes/);
        assert.equal(hits(mock, 'DELETE', /segments\/31$/).length, 0);
        assert.equal((await runEf(root, ['audiences', 'delete', '31', '--yes'])).code, 0);
        assert.equal(hits(mock, 'DELETE', /segments\/31$/).length, 1);
    });
});

test('email create sets the audience and writes the HTML body; test send needs no confirmation', async () => {
    await withMock(async (mock, root) => {
        const html = path.join(root, 'e.html');
        await fs.promises.writeFile(html, '<p>Hi</p>');
        const r = await runEf(root, ['campaigns', 'email', 'create', '--name', 'Oct', '--subject', 'Restock?', '--audience', '31', '--html-file', html, '--json']);
        assert.equal(r.code, 0, r.stderr);
        const created = hits(mock, 'POST', /\/email-campaigns$/)[0].body;
        assert.equal(created.subject, 'Restock?');
        assert.equal(created.audience_type, 'analytics_segment');
        assert.deepEqual(created.audience_config, { segment_id: 31 });
        assert.equal(created.content_source, 'default');
        assert.equal(hits(mock, 'POST', /\/emails\/900\/builder$/)[0].body.html, '<p>Hi</p>');

        const t = await runEf(root, ['campaigns', 'email', 'test', '17', '--to', 'me@example.test']);
        assert.equal(t.code, 0, t.stderr);
        assert.match(t.stderr, /Test sent to me@example\.test via log/);
        assert.deepEqual(hits(mock, 'POST', /send-test$/)[0].body, { to: 'me@example.test' });

        const both = await runEf(root, ['campaigns', 'email', 'set', '17', '--audience', '31', '--all-customers']);
        assert.equal(both.code, 2);
        assert.match(both.stderr, /Pick one audience/);
    });
});

test('email launch prints the audience size and refuses without --yes; with --yes it launches', async () => {
    await withMock(async (mock, root) => {
        const no = await runEf(root, ['campaigns', 'email', 'launch', '17']);
        assert.equal(no.code, 2);
        assert.match(no.stderr, /45 will receive it/);
        assert.match(no.stderr, /3 suppressed, 2 without consent/);
        assert.match(no.stderr, /--yes/);
        assert.equal(hits(mock, 'POST', /\/launch$/).length, 0, 'nothing launched without --yes');

        const yes = await runEf(root, ['campaigns', 'email', 'launch', '17', '--yes', '--json']);
        assert.equal(yes.code, 0, yes.stderr);
        assert.equal(JSON.parse(yes.stdout).audience.count, 45);
        assert.deepEqual(hits(mock, 'POST', /\/email-campaigns\/17\/launch$/)[0].body, {});

        const sched = await runEf(root, ['campaigns', 'email', 'schedule', '17', '--at', '2099-01-01T10:00:00Z']);
        assert.equal(sched.code, 2);
        assert.match(sched.stderr, /Schedule it for 2099-01-01T10:00:00\.000Z to 45 people/);
        const s2 = await runEf(root, ['campaigns', 'email', 'schedule', '17', '--at', '2099-01-01T10:00:00Z', '--yes']);
        assert.equal(s2.code, 0, s2.stderr);
        assert.equal(hits(mock, 'POST', /\/email-campaigns\/17\/launch$/)[1].body.schedule_at, '2099-01-01T10:00:00.000Z');

        const past = await runEf(root, ['campaigns', 'email', 'schedule', '17', '--at', '2001-01-01T00:00:00Z', '--yes']);
        assert.equal(past.code, 2);
        assert.match(past.stderr, /in the future/);

        const untested = await runEf(root, ['campaigns', 'email', 'launch', '18', '--yes']);
        assert.equal(untested.code, 2);
        assert.match(untested.stderr, /send a test first/);
    });
});

test('sms: create with text and audience, preview, audience-preview, launch gated by --yes', async () => {
    await withMock(async (mock, root) => {
        const c = await runEf(root, ['campaigns', 'sms', 'create', '--name', 'Flash', '--body', 'Hi {first_name|there}', '--audience', '31', '--exclude', '40']);
        assert.equal(c.code, 0, c.stderr);
        assert.deepEqual(hits(mock, 'POST', /\/sms\/campaigns$/)[0].body, { name: 'Flash', include_opt_out: true });
        const upd = hits(mock, 'PUT', /\/sms\/campaigns\/9$/)[0].body;
        assert.equal(upd.body, 'Hi {first_name|there}');
        assert.deepEqual(upd.audience, { segment_ids: [31], exclude_segment_ids: [40] });

        const p = await runEf(root, ['campaigns', 'sms', 'preview', '9']);
        assert.equal(p.code, 0, p.stderr);
        assert.match(p.stderr, /1 segment\(s\), GSM-7/);

        const a = await runEf(root, ['campaigns', 'sms', 'audience-preview', '9']);
        assert.equal(a.code, 0, a.stderr);
        assert.match(a.stderr, /10 reachable of 12/);
        assert.deepEqual(hits(mock, 'POST', /sms\/campaigns\/preview-audience$/)[0].body, { audience: { segment_ids: [31], exclude_segment_ids: [] }, exclude_regions: [] });

        const no = await runEf(root, ['campaigns', 'sms', 'launch', '9']);
        assert.equal(no.code, 2);
        assert.match(no.stderr, /Start sending now to 10 phones\?/);
        assert.equal(hits(mock, 'POST', /sms\/campaigns\/9\/launch$/).length, 0);
        assert.equal((await runEf(root, ['campaigns', 'sms', 'launch', '9', '--yes'])).code, 0);
        assert.equal(hits(mock, 'POST', /sms\/campaigns\/9\/launch$/).length, 1);
    });
});

test('ef-segql and ef-campaigns skills ship with short descriptions', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-skills-camp-'));
    try {
        const installed = await installBundledSkills(dir);
        for (const name of ['ef-segql', 'ef-campaigns']) {
            assert.ok(installed.includes(name), `expected ${name}; got ${JSON.stringify(installed)}`);
            const body = await fs.promises.readFile(path.join(dir, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
            assert.match(body, new RegExp(`\\nname: ${name}\\b`));
            const desc = /description: >-\n((?: {2}.*\n)+)/.exec(body);
            assert.ok(desc, 'folded description');
            const text = desc![1].split('\n').map((l) => l.trim()).join(' ').trim();
            assert.ok(text.length <= 250, `${name} description is ${text.length} chars`);
        }
        const segql = await fs.promises.readFile(path.join(dir, '.claude', 'skills', 'ef-segql', 'SKILL.md'), 'utf8');
        assert.match(segql, /silent 0/, 'a wrong value counts zero, not an error');
        assert.match(segql, /COUNT order\(\)/, 'orders, not purchase rows');
        const camp = await fs.promises.readFile(path.join(dir, '.claude', 'skills', 'ef-campaigns', 'SKILL.md'), 'utf8');
        assert.match(camp, /Never launch or schedule without the user's explicit go/);
        assert.match(camp, /8am to 8pm/);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});
