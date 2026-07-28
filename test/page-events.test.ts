import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
const GRAPH = { drawflow: { Home: { data: { '1': { id: 1, name: 'page', data: { value: 10 } } } } } };

interface Mock { url: string; close: () => Promise<void>; posts: { id: string; body: unknown }[]; validates: string[]; setEvents: (id: number, g: unknown) => void; }

function startMock(): Promise<Mock> {
    const events: Record<number, unknown> = { 10: GRAPH, 20: '' }; // page 20 has no events
    const posts: { id: string; body: unknown }[] = [];
    const validates: string[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = (req.url || '').split('?')[0];
                const json = (payload: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
                if (req.method === 'GET' && /\/pages\/all$/.test(url)) {
                    return json([
                        { id: 10, slug: 'home', title: 'Home', is_active_version: true, variant_slug: null, parent_page_id: null },
                        { id: 20, slug: 'checkout/step-1', title: 'Step 1', is_active_version: true, variant_slug: null, parent_page_id: null },
                    ]);
                }
                let m = /\/pages\/(\d+)\/events\/validate$/.exec(url);
                if (m && req.method === 'POST') { validates.push(m[1]); return json({ errors: [], warnings: [] }); }
                m = /\/pages\/(\d+)\/events\/node-vocabulary$/.exec(url);
                if (m) return json({ nodes: [{ type: 'split_test' }], notes: {} });
                m = /\/pages\/(\d+)\/events$/.exec(url);
                if (m) {
                    const id = parseInt(m[1], 10);
                    if (req.method === 'GET') {
                        const g = events[id];
                        if (g === '' || g == null) { res.writeHead(200); return res.end(''); }
                        return json(g);
                    }
                    if (req.method === 'POST') { try { posts.push({ id: m[1], body: JSON.parse(b) }); } catch { posts.push({ id: m[1], body: null }); } return json({ ok: true }); }
                }
                json({});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), posts, validates, setEvents: (id, g) => { events[id] = g; } });
        });
    });
}

async function setup(apiUrl: string): Promise<{ root: string; brandRoot: string }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-events-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return { root, brandRoot: path.join(root, 'elasticfunnels') };
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

test('pages events pull writes the graph to pages/<slug>.events.json', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        const r = await runEf(root, ['pages', 'events', 'pull', 'home', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const file = path.join(brandRoot, 'pages', 'home.events.json');
        assert.ok(fs.existsSync(file), 'events file written beside the page');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), GRAPH);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('pages events pull handles a slug with "/" (nested path)', async () => {
    const mock = await startMock();
    mock.setEvents(20, { drawflow: { Home: { data: { '1': { id: 1 } } } } });
    const { root, brandRoot } = await setup(mock.url);
    try {
        const r = await runEf(root, ['pages', 'events', 'pull', 'checkout/step-1', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.ok(fs.existsSync(path.join(brandRoot, 'pages', 'checkout', 'step-1.events.json')), 'nested events path created');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('pages events pull writes a starter skeleton when the page has no events', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        const r = await runEf(root, ['pages', 'events', 'pull', 'checkout/step-1', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const g = JSON.parse(fs.readFileSync(path.join(brandRoot, 'pages', 'checkout', 'step-1.events.json'), 'utf8'));
        assert.deepEqual(g, { drawflow: { Home: { data: {} } } }, 'empty starter graph');
        assert.equal(JSON.parse(r.stdout).empty, true);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('pages events push REFUSES when the server graph changed since pull; diff shows it; --force overrides', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        // Pull establishes the baseline.
        assert.equal((await runEf(root, ['pages', 'events', 'pull', 'home', '--json'])).code, 0);
        const file = path.join(brandRoot, 'pages', 'home.events.json');
        // Server graph moves (someone else edited); we also edit locally.
        mock.setEvents(10, { drawflow: { Home: { data: { '1': { id: 1, who: 'SERVER' } } } } });
        await fs.promises.writeFile(file, JSON.stringify({ drawflow: { Home: { data: { '1': { id: 1, who: 'LOCAL' } } } } }));

        const push = await runEf(root, ['pages', 'events', 'push', 'home', '--json']);
        assert.equal(push.code, 4, `expected conflict; stderr=${push.stderr}`);
        assert.match(JSON.parse(push.stdout).message, /Changes rejected/);
        assert.equal(mock.posts.length, 0, 'nothing pushed on drift');

        const diff = await runEf(root, ['pages', 'events', 'diff', 'home', '--json']);
        assert.equal(JSON.parse(diff.stdout).changed, true, 'diff reports a difference');

        const forced = await runEf(root, ['pages', 'events', 'push', 'home', '--force', '--json']);
        assert.equal(forced.code, 0, `--force stderr=${forced.stderr}`);
        assert.equal(mock.posts.length, 1, '--force pushed local over the server');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('ef diff pages/<slug>.events.json diffs the events file against the server', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        assert.equal((await runEf(root, ['pages', 'events', 'pull', 'home', '--json'])).code, 0);
        // Freshly pulled → clean.
        let entries = JSON.parse((await runEf(root, ['diff', 'pages/home.events.json', '--json'])).stdout) as { kind: string; status: string; diff?: string }[];
        assert.equal(entries[0].kind, 'events');
        assert.equal(entries[0].status, 'clean');
        // Edit locally → dirty, with a diff.
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'home.events.json'), JSON.stringify({ drawflow: { Home: { data: { '1': { id: 1, who: 'LOCAL' } } } } }));
        entries = JSON.parse((await runEf(root, ['diff', 'pages/home.events.json', '--json'])).stdout) as { kind: string; status: string; diff?: string }[];
        assert.equal(entries[0].kind, 'events');
        assert.equal(entries[0].status, 'dirty');
        assert.ok(entries[0].diff && /LOCAL/.test(entries[0].diff), 'diff shows the local change');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('pages events push validates then POSTs the local graph', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        const dir = path.join(brandRoot, 'pages');
        await fs.promises.mkdir(dir, { recursive: true });
        const local = { drawflow: { Home: { data: { '1': { id: 1, name: 'page' } } } } };
        await fs.promises.writeFile(path.join(dir, 'home.events.json'), JSON.stringify(local));
        const r = await runEf(root, ['pages', 'events', 'push', 'home', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.deepEqual(mock.validates, ['10'], 'validated before pushing');
        assert.equal(mock.posts.length, 1);
        assert.equal(mock.posts[0].id, '10');
        assert.deepEqual(mock.posts[0].body, local, 'the local graph was posted verbatim');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
