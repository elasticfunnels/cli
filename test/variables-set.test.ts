import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { once } from 'events';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Mock {
    url: string;
    close: () => Promise<void>;
    lastSet: () => Record<string, unknown> | null;
    setGet: (v: Record<string, unknown>) => void;
}

/** Mock server for /api/brands/:id/variables — GET returns the current blob
 *  (as the app does, a JSON string under `variables`), POST captures the set. */
function startMock(initial: Record<string, unknown>): Promise<Mock> {
    let current = initial;
    let captured: Record<string, unknown> | null = null;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = req.url || '';
                if (/\/variables$/.test(url) && req.method === 'GET') {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ variables: JSON.stringify(current) }));
                    return;
                }
                if (/\/variables$/.test(url) && req.method === 'POST') {
                    try {
                        const parsed = JSON.parse(b) as { variables?: string };
                        captured = JSON.parse(parsed.variables ?? '{}') as Record<string, unknown>;
                        current = captured;
                    } catch { /* leave captured null → test fails loudly */ }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end('{"ok":true}');
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
                lastSet: () => captured,
                setGet: (v) => { current = v; },
            });
        });
    });
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-varset-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return root;
}

/** Run the CLI async (spawnSync would deadlock the in-process mock server). */
function runEf(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('variables set: dotted key nests, JSON-typed value, merges with existing', async () => {
    const mock = await startMock({ existing: 'keep', brand: { domain: 'old.com' } });
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['variables', 'set', 'brand.name', 'Acme Nerve Relief']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const set = mock.lastSet();
        assert.ok(set, 'server received a POST');
        // Existing top-level key preserved.
        assert.equal(set!.existing, 'keep');
        // Existing sibling under brand preserved; new key added.
        assert.deepEqual(set!.brand, { domain: 'old.com', name: 'Acme Nerve Relief' });
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('variables set: number and boolean are typed, not stringified', async () => {
    const mock = await startMock({});
    const root = await setup(mock.url);
    try {
        assert.equal((await runEf(root, ['variables', 'set', 'brand.guarantee.days', '180'])).code, 0);
        assert.equal(mock.lastSet()!.brand && (mock.lastSet()!.brand as any).guarantee.days, 180);
        assert.strictEqual((mock.lastSet()!.brand as any).guarantee.days, 180, 'number, not "180"');

        assert.equal((await runEf(root, ['variables', 'set', 'funnel.has_quiz', 'true'])).code, 0);
        assert.strictEqual((mock.lastSet()!.funnel as any).has_quiz, true, 'boolean true, not "true"');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('variables set --string keeps the literal text', async () => {
    const mock = await startMock({});
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['variables', 'set', 'flag', 'true', '--string']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.strictEqual(mock.lastSet()!.flag, 'true', 'literal string "true"');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('variables set @file reads the value from a file', async () => {
    const mock = await startMock({});
    const root = await setup(mock.url);
    try {
        const copyPath = path.join(root, 'guarantee.md');
        await fs.promises.writeFile(copyPath, 'Keep the bottles, 180-day promise.\n');
        const r = await runEf(root, ['variables', 'set', 'brand.guarantee.copy', `@${copyPath}`]);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        assert.strictEqual((mock.lastSet()!.brand as any).guarantee.copy, 'Keep the bottles, 180-day promise.');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('variables set rejects descending through a non-object', async () => {
    const mock = await startMock({ brand: 'a-string-not-an-object' });
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['variables', 'set', 'brand.name', 'X']);
        assert.equal(r.code, 2, 'validation exit code');
        assert.equal(mock.lastSet(), null, 'nothing pushed when the path is invalid');
        assert.match(r.stderr, /not an object/);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
