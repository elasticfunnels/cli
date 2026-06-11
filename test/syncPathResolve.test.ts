import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSyncPathInput } from '../src/utils/syncPathResolve';
import { CliError, ExitCode } from '../src/utils/exit';

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-sync-path-'));
}

test('strip sync-folder prefix resolves pages under brand root', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = path.join(root, 'elasticfunnels', '7');
        await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'index2.ef'), 'x');
        const abs = await resolveSyncPathInput(brandRoot, 'elasticfunnels/pages/index2.ef', 'elasticfunnels');
        assert.equal(abs, path.join(brandRoot, 'pages', 'index2.ef'));
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('misplaced syncRoot/pages (no brand id folder) yields validation error', async () => {
    const root = await tmpDir();
    const prev = process.cwd();
    try {
        process.chdir(root);
        const brandRoot = path.join(root, 'elasticfunnels', '7');
        await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
        const wrong = path.join(root, 'elasticfunnels', 'pages');
        await fs.promises.mkdir(wrong, { recursive: true });
        await fs.promises.writeFile(path.join(wrong, 'index2.ef'), 'x');

        await assert.rejects(
            () => resolveSyncPathInput(brandRoot, 'elasticfunnels/pages/index2.ef', 'elasticfunnels'),
            (e: unknown) => e instanceof CliError && e.code === ExitCode.Validation,
        );
    } finally {
        process.chdir(prev);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('prefers path under brand root when both misplaced and correct exist', async () => {
    const root = await tmpDir();
    const prev = process.cwd();
    try {
        process.chdir(root);
        const brandRoot = path.join(root, 'elasticfunnels', '7');
        await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
        const wrong = path.join(root, 'elasticfunnels', 'pages');
        await fs.promises.mkdir(wrong, { recursive: true });
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'x.ef'), 'good');
        await fs.promises.writeFile(path.join(wrong, 'x.ef'), 'bad');

        const abs = await resolveSyncPathInput(brandRoot, 'elasticfunnels/pages/x.ef', 'elasticfunnels');
        assert.equal(abs, path.join(brandRoot, 'pages', 'x.ef'));
    } finally {
        process.chdir(prev);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('flat brand root: strip elasticfunnels/pages resolves under sync folder', async () => {
    const root = await tmpDir();
    try {
        const brandRoot = path.join(root, 'elasticfunnels');
        await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
        await fs.promises.writeFile(path.join(brandRoot, 'pages', 'index2.ef'), 'x');
        const abs = await resolveSyncPathInput(brandRoot, 'elasticfunnels/pages/index2.ef', 'elasticfunnels');
        assert.equal(abs, path.join(brandRoot, 'pages', 'index2.ef'));
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
