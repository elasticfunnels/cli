import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { withEfMeta } from '../src/sync/efMeta';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-copy-'));
}

interface Mock {
    url: string;
    close: () => Promise<void>;
    /** Component ids that received an editor UPDATE (POST …/components/{id}/editor). */
    editorUpdates: number[];
    /** Bodies of component CREATEs (POST …/components). */
    creates: Array<Record<string, unknown>>;
}

function startMock(): Promise<Mock> {
    const editorUpdates: number[] = [];
    const creates: Mock['creates'] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                const url = req.url || '';
                const upd = url.match(/\/components\/(\d+)\/editor$/);
                if (req.method === 'POST' && upd) {
                    editorUpdates.push(Number(upd[1]));
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ revision_id: 7 }));
                    return;
                }
                if (req.method === 'GET' && /\/components\/\d+\/editor/.test(url)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ html: '<p>x</p>', revision_id: 7, updated_at: '2026-01-01T00:00:00Z' }));
                    return;
                }
                if (req.method === 'POST' && /\/components$/.test(url)) {
                    let body: Record<string, unknown> = {};
                    try { body = JSON.parse(raw || '{}'); } catch { /* {} */ }
                    creates.push(body);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 200, code: body.code ?? null, name: body.name ?? null }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                close: () => new Promise<void>((r) => server.close(() => r())),
                editorUpdates,
                creates,
            });
        });
    });
}

async function setupBrand(root: string, apiUrl: string): Promise<string> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'fake-key\n');
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'components'), { recursive: true });
    return brandRoot;
}

function runEf(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
}

const META = (id: number, issuedPath: string) =>
    ({ v: 1 as const, type: 'component' as const, brandId: 7, id, path: issuedPath });

test('pushing a COPY creates a new component instead of overwriting the original', async () => {
    const mock = await startMock();
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root, mock.url);
        // Original (#100) and a copy that still carries #100's efmeta + original path.
        await fs.promises.writeFile(path.join(brandRoot, 'components', 'orig.ef'), withEfMeta(META(100, 'components/orig.ef'), '<p>orig</p>'));
        await fs.promises.writeFile(path.join(brandRoot, 'components', 'copy.ef'), withEfMeta(META(100, 'components/orig.ef'), '<p>copy</p>'));

        const res = await runEf(root, ['push', 'components/copy.ef', '--force', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(mock.editorUpdates.includes(100), false, 'must NOT overwrite component #100');
        assert.equal(mock.creates.length, 1, 'must create a new component');
        assert.equal(mock.creates[0].code, 'copy', 'new component takes its own filename code');
        const parsed = JSON.parse(res.stdout);
        assert.equal(parsed.pushed[0].action, 'created');
        assert.equal(parsed.pushed[0].serverId, 200);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pushing a RENAME (original gone) keeps the id and updates it', async () => {
    const mock = await startMock();
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root, mock.url);
        // Only the renamed file exists; the path its efmeta was issued for is gone.
        await fs.promises.writeFile(path.join(brandRoot, 'components', 'renamed.ef'), withEfMeta(META(100, 'components/orig.ef'), '<p>renamed</p>'));

        const res = await runEf(root, ['push', 'components/renamed.ef', '--force', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(mock.editorUpdates.includes(100), true, 'rename keeps id #100');
        assert.equal(mock.creates.length, 0, 'rename must not create a new component');
        const parsed = JSON.parse(res.stdout);
        assert.equal(parsed.pushed[0].action, 'updated');
        assert.equal(parsed.pushed[0].serverId, 100);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
