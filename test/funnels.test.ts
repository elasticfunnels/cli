import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
const GRAPH = { drawflow: { Home: { data: { '1': { id: 1, name: 'entry' } } } } };

interface Mock { url: string; close: () => Promise<void>; posts: unknown[]; setGraph: (g: unknown) => void; }

function startMock(): Promise<Mock> {
    let graph: unknown = GRAPH;
    const posts: unknown[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = (req.url || '').split('?')[0];
                const json = (p: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
                if (req.method === 'GET' && /\/funnels\/all$/.test(url)) return json([{ id: 5, code: 'demo', title: 'Demo', status: 'active' }]);
                if (/\/funnels\/5\/builder$/.test(url)) {
                    if (req.method === 'GET') { if (graph === '' || graph == null) { res.writeHead(200); return res.end(''); } return json(graph); }
                    if (req.method === 'POST') { try { posts.push(JSON.parse(b)); } catch { posts.push(null); } return json({ ok: true }); }
                }
                if (/\/funnels\/5\/debug-flow$/.test(url)) return json([{ id: 1, type: 'entry', next: [] }]);
                json({});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), posts, setGraph: (g) => { graph = g; } });
        });
    });
}

async function setup(apiUrl: string): Promise<{ root: string; brandRoot: string }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-funnels-'));
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

test('funnels pull → push round-trips the builder graph (funnels/<code>.flow.json)', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        assert.equal((await runEf(root, ['funnels', 'pull', 'demo', '--json'])).code, 0);
        const file = path.join(brandRoot, 'funnels', 'demo.flow.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), GRAPH);
        // Edit + push.
        const edited = { drawflow: { Home: { data: { '1': { id: 1, name: 'entry' }, '2': { id: 2, name: 'page' } } } } };
        await fs.promises.writeFile(file, JSON.stringify(edited));
        assert.equal((await runEf(root, ['funnels', 'push', 'demo', '--json'])).code, 0);
        assert.deepEqual(mock.posts.at(-1), edited, 'the local graph was posted');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('funnels push REFUSES on server drift; ef diff funnels/<code>.flow.json shows it; --force overrides', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        assert.equal((await runEf(root, ['funnels', 'pull', 'demo', '--json'])).code, 0);
        mock.setGraph({ drawflow: { Home: { data: { '1': { id: 1, who: 'SERVER' } } } } });
        await fs.promises.writeFile(path.join(brandRoot, 'funnels', 'demo.flow.json'), JSON.stringify({ drawflow: { Home: { data: { '1': { id: 1, who: 'LOCAL' } } } } }));

        const push = await runEf(root, ['funnels', 'push', 'demo', '--json']);
        assert.equal(push.code, 4);
        assert.match(JSON.parse(push.stdout).message, /Changes rejected/);

        const diff = JSON.parse((await runEf(root, ['diff', 'funnels/demo.flow.json', '--json'])).stdout) as { kind: string; status: string }[];
        assert.equal(diff[0].kind, 'funnel');
        assert.equal(diff[0].status, 'both-changed', 'local and server both moved from the pulled baseline');

        assert.equal((await runEf(root, ['funnels', 'push', 'demo', '--force', '--json'])).code, 0);
        assert.equal(mock.posts.length, 1, '--force pushed');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('funnels push REFUSES a never-pulled file when the server already has a graph; allows fresh-create when it has none', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        const dir = path.join(brandRoot, 'funnels');
        await fs.promises.mkdir(dir, { recursive: true });
        // Server HAS a builder graph (GRAPH). Author a different one locally without pulling.
        await fs.promises.writeFile(path.join(dir, 'demo.flow.json'), JSON.stringify({ drawflow: { Home: { data: { '1': { id: 1, who: 'LOCAL' } } } } }));
        const refused = await runEf(root, ['funnels', 'push', 'demo', '--json']);
        assert.equal(refused.code, 4, `expected refusal; stderr=${refused.stderr}`);
        assert.match(JSON.parse(refused.stdout).message, /never pulled/);
        assert.equal(mock.posts.length, 0, 'nothing pushed — server graph preserved');
        // --force overrides.
        assert.equal((await runEf(root, ['funnels', 'push', 'demo', '--force', '--json'])).code, 0);
        assert.equal(mock.posts.length, 1, '--force pushed');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('funnels push allows a brand-new graph when the server has none (fresh create, no pull needed)', async () => {
    const mock = await startMock();
    mock.setGraph(''); // server has no builder graph for this funnel
    const { root, brandRoot } = await setup(mock.url);
    try {
        const dir = path.join(brandRoot, 'funnels');
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, 'demo.flow.json'), JSON.stringify({ drawflow: { Home: { data: { '9': { id: 9, name: 'fresh' } } } } }));
        assert.equal((await runEf(root, ['funnels', 'push', 'demo', '--json'])).code, 0, 'fresh-create allowed with no pull');
        assert.equal(mock.posts.length, 1, 'fresh graph pushed');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('ef lint flags a broken graph JSON and passes a valid one', async () => {
    const mock = await startMock();
    const { root, brandRoot } = await setup(mock.url);
    try {
        const dir = path.join(brandRoot, 'funnels');
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, 'broken.flow.json'), '{ not valid json');
        assert.equal((await runEf(root, ['lint', 'funnels/broken.flow.json'])).code, 2, 'invalid JSON → error');
        await fs.promises.writeFile(path.join(dir, 'ok.flow.json'), JSON.stringify(GRAPH));
        assert.equal((await runEf(root, ['lint', 'funnels/ok.flow.json'])).code, 0, 'valid graph → ok');
        // Missing drawflow shape → error.
        await fs.promises.writeFile(path.join(dir, 'noshape.flow.json'), JSON.stringify({ hello: 'world' }));
        const r = JSON.parse((await runEf(root, ['lint', 'funnels/noshape.flow.json', '--json'])).stdout) as { issues: { message: string }[] }[];
        assert.ok(r[0].issues.some((i) => /drawflow/.test(i.message)), 'flags the missing drawflow shape');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
