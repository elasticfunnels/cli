import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { buildImportPlan } from '../src/models/crmImportPlan';
import type { ImportPreview } from '../src/api/crmImportApi';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
const HASH = 'a'.repeat(64);

function preview(): ImportPreview {
    return {
        file_hash: HASH, file_name: 'contacts.csv', row_count: 5, title_column: 0,
        columns: [
            { index: 0, header: 'Name', samples: ['Ann Lee'], choices: null, filled: 5, action: 'create', existing_key: null, suggested: { label: 'Name', key: 'name', type: 'text' } },
            { index: 1, header: 'Email', samples: ['ann@example.com'], choices: null, filled: 5, action: 'existing', existing_key: 'email', suggested: { label: 'Email', key: 'email', type: 'email' } },
            { index: 2, header: 'Plan', samples: ['Pro'], choices: ['Pro', 'Basic'], filled: 5, action: 'create', existing_key: null, suggested: { label: 'Plan', key: 'plan', type: 'select', options: [{ label: 'Pro', value: 'pro' }, { label: 'Basic', value: 'basic' }] } },
            { index: 3, header: 'Notes', samples: [], choices: null, filled: 0, action: 'skip', existing_key: null, suggested: { label: 'Notes', key: 'notes', type: 'textarea' } },
        ],
        sample_rows: [],
    };
}

test('plan: follows the server suggestion, creates only new keys', () => {
    const p = buildImportPlan(preview(), new Set(['email']));
    assert.deepEqual(p.mapping, [{ index: 0, key: 'name' }, { index: 1, key: 'email' }, { index: 2, key: 'plan' }]);
    assert.deepEqual(p.create.map((f) => f.key), ['name', 'plan']);
    assert.equal(p.create[1].options?.length, 2, 'select options carried over');
    assert.equal(p.titleColumn, 0);
});

test('plan: a suggested key that already exists is reused (re-run safe)', () => {
    const p = buildImportPlan(preview(), new Set(['email', 'name']));
    assert.deepEqual(p.create.map((f) => f.key), ['plan']);
});

test('plan: --map by header or index, --skip, --title', () => {
    const p = buildImportPlan(preview(), new Set(['email', 'full_name']), { map: ['name=full_name', '2=tier'], skip: ['email'], title: 'Plan' });
    assert.deepEqual(p.mapping, [{ index: 0, key: 'full_name' }, { index: 2, key: 'tier' }]);
    assert.deepEqual(p.create.map((f) => [f.key, f.type]), [['tier', 'select']]);
    assert.equal(p.titleColumn, 2);
});

test('plan: rejects two columns on one key, unknown columns and bad keys', () => {
    assert.throws(() => buildImportPlan(preview(), new Set(), { map: ['Plan=email'] }), /both map to field "email"/);
    assert.throws(() => buildImportPlan(preview(), new Set(), { skip: ['Phone'] }), /No column "Phone"/);
    assert.throws(() => buildImportPlan(preview(), new Set(), { map: ['Name=Full Name'] }), /must be lowercase/);
    assert.throws(() => buildImportPlan(preview(), new Set(), { skip: ['0', '1', '2'] }), /nothing to import/);
});

interface Mock { url: string; close: () => Promise<void>; previewBodies: string[]; fields: any[]; rows: any[] }

function startMock(opts: { pipelines?: unknown[]; failAtOffset?: number } = {}): Promise<Mock> {
    const previewBodies: string[] = []; const fields: any[] = []; const rows: any[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.setEncoding('latin1');
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = (req.url || '').split('?')[0];
                const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
                const m = req.method;
                if (m === 'GET' && /\/crm\/entities$/.test(url)) return json(200, [{ id: 5, slug: 'leads', name: 'Leads', entity_mode: 'crm' }]);
                if (m === 'GET' && /\/crm\/entities\/5\/fields$/.test(url)) return json(200, [{ id: 1, key: 'email', label: 'Email', type: 'email' }]);
                if (m === 'POST' && /\/crm\/entities\/5\/fields$/.test(url)) { const p = JSON.parse(b); fields.push(p); return json(200, { field: { id: 400 + fields.length, ...p } }); }
                if (m === 'GET' && /\/crm\/entities\/5\/pipelines$/.test(url)) return json(200, opts.pipelines ?? []);
                if (m === 'POST' && /\/crm\/entities\/5\/import\/preview$/.test(url)) { previewBodies.push(b); return json(200, preview()); }
                if (m === 'POST' && /\/crm\/entities\/5\/import\/rows$/.test(url)) {
                    const p = JSON.parse(b); rows.push(p);
                    if (opts.failAtOffset != null && p.offset === opts.failAtOffset) return json(500, { message: 'boom' });
                    const next = Math.min(p.offset + p.limit, 5);
                    return json(200, { imported: next - p.offset, skipped: 0, failed: 0, errors: [], next_offset: next, total: 5, done: next >= 5 });
                }
                json(404, { message: `no route ${m} ${url}` });
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), previewBodies, fields, rows });
        });
    });
}

async function setupProject(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-crm-import-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    await fs.promises.writeFile(path.join(root, 'contacts.csv'), 'Name,Email,Plan,Notes\nAnn Lee,ann@example.com,Pro,\n');
    return root;
}

function runEf(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.stdin.end();
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('import --preview uploads the file and writes nothing', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'import', 'leads', '--file', 'contacts.csv', '--preview', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.match(mock.previewBodies[0], /name="file"; filename="contacts.csv"/);
        assert.match(mock.previewBodies[0], /Content-Type: text\/csv/);
        const out = JSON.parse(r.stdout);
        assert.deepEqual(out.create.map((f: any) => f.key), ['name', 'plan']);
        assert.equal(mock.fields.length, 0); assert.equal(mock.rows.length, 0);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('import without --yes off a terminal refuses before writing', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'import', 'leads', '--file', 'contacts.csv']);
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /--yes/);
        assert.equal(mock.fields.length, 0); assert.equal(mock.rows.length, 0);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('import --yes creates new fields, then loops rows until done, with default pipeline + first stage', async () => {
    const pipelines = [
        { id: 20, name: 'Other', is_default: false, stages: [{ id: 1, order: 1 }] },
        { id: 21, name: 'Sales', is_default: true, stages: [{ id: 9, order: 2 }, { id: 8, order: 1 }] },
    ];
    const mock = await startMock({ pipelines });
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'import', 'leads', '--file', 'contacts.csv', '--batch', '2', '--yes', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.deepEqual(mock.fields.map((f) => f.key), ['name', 'plan']);
        assert.equal(mock.fields[1].options.length, 2);
        assert.deepEqual(mock.rows.map((x) => x.offset), [0, 2, 4]);
        assert.equal(mock.rows[0].file_hash, HASH);
        assert.equal(mock.rows[0].limit, 2);
        assert.equal(mock.rows[0].pipeline_id, 21); assert.equal(mock.rows[0].stage_id, 8);
        assert.deepEqual(mock.rows[0].mapping, [{ index: 0, key: 'name' }, { index: 1, key: 'email' }, { index: 2, key: 'plan' }]);
        const out = JSON.parse(r.stdout);
        assert.equal(out.imported, 5); assert.deepEqual(out.fields_created, ['name', 'plan']);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('import that fails mid-way prints the --offset to resume from', async () => {
    const mock = await startMock({ failAtOffset: 2 });
    const root = await setupProject(mock.url);
    try {
        const r = await runEf(root, ['crm', 'import', 'leads', '--file', 'contacts.csv', '--batch', '2', '--yes']);
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /Imported 2 so far/);
        assert.match(r.stderr, /--offset 2/);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('import refuses .xls before uploading', async () => {
    const mock = await startMock();
    const root = await setupProject(mock.url);
    try {
        await fs.promises.writeFile(path.join(root, 'old.xls'), 'x');
        const r = await runEf(root, ['crm', 'import', 'leads', '--file', 'old.xls', '--preview']);
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /\.xlsx or \.csv/);
        assert.equal(mock.previewBodies.length, 0);
    } finally { await mock.close(); await fs.promises.rm(root, { recursive: true, force: true }); }
});
