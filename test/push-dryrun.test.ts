import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-push-'));
}

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

function runEf(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
    const res = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

async function setupBrand(root: string): Promise<string> {
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl: 'https://example.test', brandId: 7, syncRoot: 'elasticfunnels', saveMode: 'draft' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'fake-key\n');
    const brandRoot = path.join(root, 'elasticfunnels', '7');
    await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
    return brandRoot;
}

test('push --dry-run reports "would create" for a fresh page with no efmeta', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'fresh.ef'), '<p>fresh content</p>');

        const res = runEf(root, ['push', '--all', '--dry-run', '--json']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        const parsed = JSON.parse(res.stdout);
        assert.equal(parsed.dryRun, true);
        const fresh = parsed.planned.find((r: { rel: string }) => r.rel === 'pages/fresh.ef');
        assert.ok(fresh);
        assert.equal(fresh.action, 'create');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('push --dry-run reports "would update" for a page with valid efmeta', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        const meta = JSON.stringify({ v: 1, type: 'page', brandId: 7, id: 99, slug: 'home', name: 'Home' });
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'home.ef'), `{{-- efmeta:${meta} --}}\n<p>body</p>`);

        const res = runEf(root, ['push', '--all', '--dry-run', '--json']);
        assert.equal(res.status, 0);
        const parsed = JSON.parse(res.stdout);
        const home = parsed.planned.find((r: { rel: string }) => r.rel === 'pages/home.ef');
        assert.ok(home);
        assert.equal(home.action, 'update');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('push --dry-run does not contact the network even if the API is offline', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'a.ef'), '<p>a</p>');
        // apiUrl already points at example.test (unreachable). A dry run must
        // still succeed because it never makes an HTTP call.
        const res = runEf(root, ['push', '--all', '--dry-run', '--json']);
        assert.equal(res.status, 0, `expected exit 0 even with unreachable API, got ${res.status}\nstderr=${res.stderr}`);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
