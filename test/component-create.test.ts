import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-compcreate-'));
}

interface Mock {
    url: string;
    close: () => Promise<void>;
    creates: Array<Record<string, unknown>>;
}

// Captures the body of POST …/components so we can assert `code` is sent.
function startMock(): Promise<Mock> {
    const creates: Mock['creates'] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                if (req.method === 'POST' && /\/components$/.test(req.url || '')) {
                    let body: Record<string, unknown> = {};
                    try { body = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
                    creates.push(body);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 99, code: body.code ?? null, name: body.name ?? null }));
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
                creates,
            });
        });
    });
}

async function setupBrand(root: string, apiUrl: string): Promise<void> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'fake-key\n');
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

test('ef components create sends the real code (not an empty string)', async () => {
    const mock = await startMock();
    const root = await tmpDir();
    try {
        await setupBrand(root, mock.url);
        // --no-pull so we don't have to mock the editor GET; we only assert the create body.
        const res = await runEf(root, ['components', 'create', 'meta-tracking', '--no-pull', '--json']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        assert.equal(mock.creates.length, 1, 'exactly one component create');
        assert.equal(mock.creates[0].code, 'meta-tracking', 'code must be the user-supplied slug, not ""/null');
        assert.equal(typeof mock.creates[0].code, 'string');
        assert.equal(mock.creates[0].name, 'Meta Tracking', 'name humanized from the code');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('ef components create --name overrides the humanized name but keeps the code', async () => {
    const mock = await startMock();
    const root = await tmpDir();
    try {
        await setupBrand(root, mock.url);
        const res = await runEf(root, ['components', 'create', 'meta-tracking', '--name', 'Meta Pixel', '--no-pull', '--json']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        assert.equal(mock.creates[0].code, 'meta-tracking');
        assert.equal(mock.creates[0].name, 'Meta Pixel');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
