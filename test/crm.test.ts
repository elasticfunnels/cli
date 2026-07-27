import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Captured { path: string; payload: Record<string, unknown>; }
interface Mock {
    url: string;
    close: () => Promise<void>;
    paths: string[];
    entities: Captured[];
    pipelines: Captured[];
    stages: Captured[];
    fields: Captured[];
    entries: Captured[];
    entryUpdates: Captured[];
    entryMoves: Captured[];
}

function startMock(): Promise<Mock> {
    const paths: string[] = [];
    const entities: Captured[] = [];
    const pipelines: Captured[] = [];
    const stages: Captured[] = [];
    const fields: Captured[] = [];
    const entries: Captured[] = [];
    const entryUpdates: Captured[] = [];
    const entryMoves: Captured[] = [];
    const SEED = [{ id: 5, slug: 'leads', name: 'Leads', entity_mode: 'crm' }];

    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = (req.url || '').split('?')[0];
                paths.push(`${req.method} ${url}`);
                const body = (): Record<string, unknown> => { try { return JSON.parse(b) as Record<string, unknown>; } catch { return {}; } };
                const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
                const m = req.method;

                if (m === 'GET' && /\/crm\/entities$/.test(url)) return json(200, SEED);
                if (m === 'POST' && /\/crm\/entities$/.test(url)) { const p = body(); entities.push({ path: url, payload: p }); return json(200, { entity: { id: 100, ...p } }); }
                if (m === 'GET' && /\/crm\/entities\/\d+$/.test(url)) return json(200, { entity: SEED[0] });

                if (m === 'POST' && /\/crm\/entities\/\d+\/pipelines$/.test(url)) { const p = body(); pipelines.push({ path: url, payload: p }); return json(200, { pipeline: { id: 200, ...p } }); }
                if (m === 'GET' && /\/crm\/entities\/\d+\/pipelines$/.test(url)) return json(200, []);

                if (m === 'POST' && /\/crm\/pipelines\/\d+\/stages$/.test(url)) { const p = body(); stages.push({ path: url, payload: p }); return json(200, { stage: { id: 300, ...p } }); }
                if (m === 'GET' && /\/crm\/pipelines\/\d+\/stages$/.test(url)) return json(200, []);

                if (m === 'POST' && /\/crm\/entities\/\d+\/fields$/.test(url)) { const p = body(); fields.push({ path: url, payload: p }); return json(200, { field: { id: 400, ...p } }); }
                if (m === 'GET' && /\/crm\/entities\/\d+\/fields$/.test(url)) return json(200, []);

                if (m === 'POST' && /\/crm\/entities\/\d+\/entries$/.test(url)) { const p = body(); entries.push({ path: url, payload: p }); return json(200, { entry: { id: 'es-1', ...p } }); }
                if (m === 'GET' && /\/crm\/entities\/\d+\/entries$/.test(url)) return json(200, { data: [] });
                if (m === 'PUT' && /\/crm\/entries\/[^/]+\/stage$/.test(url)) { const p = body(); entryMoves.push({ path: url, payload: p }); return json(200, { entry: { id: 'es-1' } }); }
                if (m === 'PUT' && /\/crm\/entries\/[^/]+$/.test(url)) { const p = body(); entryUpdates.push({ path: url, payload: p }); return json(200, { entry: { id: 'es-1' } }); }
                if (m === 'GET' && /\/crm\/entries\/[^/]+$/.test(url)) return json(200, { entry: { id: 'es-1', title: 'x' } });
                if (m === 'DELETE') return json(200, { ok: true });

                json(200, {});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), paths, entities, pipelines, stages, fields, entries, entryUpdates, entryMoves });
        });
    });
}

async function setupProject(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-crm-'));
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

test('crm entities list returns rows', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'entities', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const rows = JSON.parse(r.stdout) as { slug: string }[];
        assert.equal(rows[0].slug, 'leads');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm resolves an entity slug → id before hitting sub-resources', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'pipelines', 'leads', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.ok(mock.paths.includes('GET /api/brands/7/crm/entities'), 'listed entities to resolve the slug');
        assert.ok(mock.paths.includes('GET /api/brands/7/crm/entities/5/pipelines'), 'used the resolved id 5');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm entities create: flags override --input-json', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'entities', 'create', '--input-json', '{"name":"FromJson","slug":"deals","entity_mode":"data"}', '--name', 'FromFlag', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const p = mock.entities[0].payload;
        assert.equal(p.name, 'FromFlag', 'flag wins over json');
        assert.equal(p.slug, 'deals', 'json field kept when no flag');
        assert.equal(p.entity_mode, 'data');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm --generate-skeleton prints JSON and makes no request', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'fields', 'create', 'leads', '--generate-skeleton']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const skel = JSON.parse(r.stdout) as { type: string };
        assert.equal(skel.type, 'text');
        assert.equal(mock.fields.length, 0, 'no create request was made');
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm entries create sends flat values + pipeline/stage under the resolved entity', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'entries', 'create', 'leads', '--title', 'Jane', '--pipeline', '11', '--stage', '22', '--values', '{"budget":5000,"email":"j@x.com"}', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const cap = mock.entries[0];
        assert.equal(cap.path, '/api/brands/7/crm/entities/5/entries');
        assert.equal(cap.payload.title, 'Jane');
        assert.equal(cap.payload.pipeline_id, 11);
        assert.equal(cap.payload.stage_id, 22);
        assert.deepEqual(cap.payload.values, { budget: 5000, email: 'j@x.com' });
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm entries move PUTs the stage', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'entries', 'move', 'es-1', '--stage', '22', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.equal(mock.entryMoves[0].path, '/api/brands/7/crm/entries/es-1/stage');
        assert.equal(mock.entryMoves[0].payload.stage_id, 22);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm fields create rejects an unknown type (exit 2)', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'fields', 'create', 'leads', '--label', 'X', '--key', 'x', '--type', 'bogus']);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /Unknown field type/);
        assert.equal(mock.fields.length, 0);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm --input-json and --input-file are mutually exclusive (exit 2)', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'entities', 'create', '--input-json', '{"name":"x"}', '--input-file', '-'], '{"name":"y"}');
        assert.equal(r.code, 2);
        assert.match(r.stderr, /mutually exclusive/);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('crm entries create reads payload from --input-file - (stdin)', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'entries', 'create', 'leads', '--input-file', '-', '--json'], '{"title":"Piped","pipeline_id":1,"stage_id":2,"values":{"a":1}}');
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.equal(mock.entries[0].payload.title, 'Piped');
        assert.deepEqual(mock.entries[0].payload.values, { a: 1 });
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
