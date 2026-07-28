import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
const PREVIEW_URL = 'https://demo.elasticpages.co/preview-component?key=abc&code=demo&nc=1&preview=1';

interface Mock { url: string; close: () => Promise<void>; previewQueries: string[]; }

function startMock(): Promise<Mock> {
    const previewQueries: string[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const url = req.url || '';
                const p = url.split('?')[0];
                if (/\/components\/all$/.test(p)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify([{ id: 42, code: 'demo', name: 'Demo' }]));
                    return;
                }
                if (/\/components\/42\/editor$/.test(p)) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 42, code: 'demo', name: 'Demo', html: '', revision_id: 7 }));
                    return;
                }
                if (/\/components\/42\/preview$/.test(p)) {
                    previewQueries.push(url.split('?')[1] ?? '');
                    // The real server 302-redirects to the public render URL.
                    res.writeHead(302, { Location: PREVIEW_URL });
                    res.end();
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), previewQueries });
        });
    });
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-cprev-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return root;
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

test('components preview reads the 302 Location as the preview URL (draft revision)', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['components', 'preview', 'demo', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const out = JSON.parse(r.stdout) as { previewUrl: string; revisionId: number | null; componentId: number };
        assert.equal(out.previewUrl, PREVIEW_URL);
        assert.equal(out.componentId, 42);
        assert.equal(out.revisionId, 7, 'previews the current draft revision');
        assert.ok(mock.previewQueries.some((q) => /revision_id=7/.test(q)), 'preview request carried revision_id=7');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('components preview --published omits the revision', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        const r = await runEf(root, ['components', 'preview', 'demo', '--published', '--json']);
        assert.equal(r.code, 0, `stderr=${r.stderr}`);
        const out = JSON.parse(r.stdout) as { previewUrl: string; revisionId: number | null };
        assert.equal(out.previewUrl, PREVIEW_URL);
        assert.equal(out.revisionId, null);
        assert.ok(mock.previewQueries.every((q) => !/revision_id/.test(q)), 'no revision_id on --published');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
