import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-diff-'));
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

test('ef diff reports unknown when there is no efmeta and no state entry', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'fresh.ef'), '<p>fresh content</p>');

        const res = runEf(root, ['diff', '--json']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        const parsed = JSON.parse(res.stdout);
        assert.ok(Array.isArray(parsed));
        const fresh = parsed.find((r: { rel: string }) => r.rel === 'pages/fresh.ef');
        assert.ok(fresh, 'expected fresh.ef in the diff output');
        assert.equal(fresh.status, 'unknown');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('ef diff reports clean when contentHash matches the state entry', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        const meta = JSON.stringify({ v: 1, type: 'page', brandId: 7, id: 1, slug: 'home', name: 'Home' });
        const body = '<p>hi</p>';
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'home.ef'), `{{-- efmeta:${meta} --}}\n${body}`);
        // Pre-seed state: contentHash matches the body's sha256.
        const crypto = await import('crypto');
        const hash = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
        await fs.promises.writeFile(path.join(brandRoot, '.ef-state.json'), JSON.stringify({
            version: 1, brandId: 7,
            pages: { 'pages/home.ef': { path: 'pages/home.ef', id: 1, type: 'page', contentHash: hash } },
            components: {}, scripts: {}, assets: {}, templatePages: {},
        }));

        const res = runEf(root, ['diff', '--json']);
        const parsed = JSON.parse(res.stdout);
        const home = parsed.find((r: { rel: string }) => r.rel === 'pages/home.ef');
        assert.ok(home);
        assert.equal(home.status, 'clean');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('ef diff reports dirty when contentHash differs from state entry', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        const meta = JSON.stringify({ v: 1, type: 'page', brandId: 7, id: 1, slug: 'home', name: 'Home' });
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'home.ef'), `{{-- efmeta:${meta} --}}\n<p>EDITED</p>`);
        // State remembers a different hash → dirty.
        await fs.promises.writeFile(path.join(brandRoot, '.ef-state.json'), JSON.stringify({
            version: 1, brandId: 7,
            pages: { 'pages/home.ef': { path: 'pages/home.ef', id: 1, type: 'page', contentHash: 'baseline-different' } },
            components: {}, scripts: {}, assets: {}, templatePages: {},
        }));

        const res = runEf(root, ['diff', '--summary', '--json']);
        const parsed = JSON.parse(res.stdout);
        assert.equal(parsed.counts.dirty, 1);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('ef diff resolves pages path from project root (brandRoot, not cwd)', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'about.ef'), '<p>x</p>');

        const res = runEf(root, ['diff', 'pages/about.ef', '--json']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        const parsed = JSON.parse(res.stdout);
        assert.ok(Array.isArray(parsed));
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].rel, 'pages/about.ef');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('ef diff accepts page slug shorthand', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = await setupBrand(root);
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'index2.ef'), '<p>x</p>');

        const res = runEf(root, ['diff', 'index2', '--json']);
        assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr=${res.stderr}`);
        const parsed = JSON.parse(res.stdout);
        assert.equal(parsed[0].rel, 'pages/index2.ef');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
