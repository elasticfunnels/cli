import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { describeMoveChanges } from '../src/commands/domains';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Req { method: string; url: string; body: Record<string, unknown> | null }

/**
 * Stands in for the Domains move API: brand 7 owns domain 11; brand 8 is in the
 * same organization, brand 9 in another one (422, like
 * DomainsController::moveOrganizationError), brand 10 lacks domains.update (403).
 */
function startMock(): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
    const requests: Req[] = [];
    const preview = (target: number, movePages: boolean) => ({
        domain: 'shop.example.com', domain_id: 11, source_brand_id: 7, target_brand_id: target,
        changes: [
            { type: 'domain_transfer', domain: 'shop.example.com', domain_id: 11, from_brand: 7, to_brand: target },
            { type: 'links_unassign', funnels: 2, blogs: 0, courses: 1, course_domain: false, tracking_scripts: 0, merchant: true },
            movePages ? { type: 'pages_move', count: 3, pages: [] } : { type: 'pages_unassign', count: 3 },
        ],
        warnings: [],
        summary: 'Domain "shop.example.com" will be transferred to the target project.',
    });
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

                if (req.method === 'GET' && url === '/api/brands/7/domains') {
                    return json({ data: [{ id: 11, domain: 'shop.example.com', status: 'validated' }], last_page: 1 });
                }
                if (req.method === 'GET' && url === '/api/brands/7/domains/11') {
                    return json({ id: 11, domain: 'shop.example.com', status: 'validated' });
                }
                if (req.method === 'GET' && url === '/api/brands/all') {
                    return json([{ id: 7, name: 'Source' }, { id: 8, name: 'Main Store' }, { id: 9, name: 'Other Org' }]);
                }
                const m = /^\/api\/brands\/7\/domains\/11\/move\/(preview|apply)$/.exec(url);
                if (req.method === 'POST' && m) {
                    const target = Number(body?.target_brand_id);
                    if (target === 9) return json({ error: 'A domain can only move to a project in the same organization.' }, 422);
                    if (target === 10) return json({ error: 'You do not have required permissions in source and/or target projects.', missing_permissions: ['domains.update@brand:10'] }, 403);
                    if (m[1] === 'preview') return json(preview(target, Boolean(body?.move_pages)));
                    if (body?.move_pages) return json({ queued: true, message: 'Move operation queued.' }, 202);
                    return json({ queued: false, moved: true, domain_id: 11, target_brand_id: target, result: { domain_moved: true, warnings: ['3 page(s) were unassigned from this domain (kept in source project).'] } });
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
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-domains-move-'));
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

const applies = (reqs: Req[]) => reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/move/apply'));

test('domains move: previews, then moves a domain-only move in one request', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const r = await runEf(root, ['domains', 'move', 'shop.example.com', '--to-brand', 'Main Store', '--yes']);
        assert.equal(r.code, 0, r.stderr);
        const out = r.stdout + r.stderr;
        assert.match(out, /2 funnel links, 1 course/);
        assert.match(out, /merchant belongs to this brand/);
        assert.match(out, /Moved shop\.example\.com \(#11\) to brand #8/);
        const [apply] = applies(mock.requests);
        assert.deepEqual(apply.body, { target_brand_id: 8, move_pages: false, component_action: null });
    } finally { await mock.close(); }
});

test('domains move: --dry-run and a missing --yes off a terminal never apply', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const dry = await runEf(root, ['domains', 'move', '11', '--to-brand', '8', '--dry-run', '--json']);
        assert.equal(dry.code, 0, dry.stderr);
        assert.equal(JSON.parse(dry.stdout).preview.target_brand_id, 8);
        const noYes = await runEf(root, ['domains', 'move', '11', '--to-brand', '8']);
        assert.equal(noYes.code, 2);
        assert.match(noYes.stderr, /--yes/);
        assert.equal(applies(mock.requests).length, 0);
    } finally { await mock.close(); }
});

test('domains move: --with-pages sends the component action and reports the queued move', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const r = await runEf(root, ['domains', 'move', '11', '--to-brand', '8', '--with-pages', '--components', 'copy', '--yes']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout + r.stderr, /queued/);
        assert.deepEqual(applies(mock.requests)[0].body, { target_brand_id: 8, move_pages: true, component_action: 'copy' });
    } finally { await mock.close(); }
});

test('domains move: server refusals are clear and exit 2, not a credential error', async () => {
    const mock = await startMock();
    try {
        const root = await setup(mock.url);
        const org = await runEf(root, ['domains', 'move', '11', '--to-brand', '9', '--yes']);
        assert.equal(org.code, 2);
        assert.match(org.stderr, /same organization/);
        const perm = await runEf(root, ['domains', 'move', '11', '--to-brand', '10', '--yes']);
        assert.equal(perm.code, 2);
        assert.match(perm.stderr, /domains\.update@brand:10/);
        assert.doesNotMatch(perm.stderr, /Credential was rejected/);
        const same = await runEf(root, ['domains', 'move', '11', '--to-brand', '7', '--yes']);
        assert.equal(same.code, 2);
        const badComponents = await runEf(root, ['domains', 'move', '11', '--to-brand', '8', '--components', 'copy', '--yes']);
        assert.equal(badComponents.code, 2);
        assert.equal(applies(mock.requests).length, 0);
    } finally { await mock.close(); }
});

test('describeMoveChanges: one plain line per change', () => {
    const lines = describeMoveChanges({
        domain: 'a.com', domain_id: 1, source_brand_id: 7, target_brand_id: 8, warnings: [], summary: '',
        changes: [
            { type: 'domain_transfer' },
            { type: 'pages_unassign', count: 1 },
            { type: 'links_unassign', funnels: 1, blogs: 2, courses: 0, course_domain: true, tracking_scripts: 0, merchant: false },
        ],
    });
    assert.deepEqual(lines, [
        'Domain moves to brand #8. DNS, SSL and validation stay as they are.',
        '1 page on this domain stays in this brand, without a domain (pass --with-pages to move them).',
        'Stop using it in this brand: 1 funnel link, 2 blogs, the courses domain setting.',
    ]);
});
