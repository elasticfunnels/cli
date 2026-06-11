import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    loadApiKey,
    loadConfig,
    loadRuntime,
    persistLogin,
    clearLogin,
    findProjectRoot,
} from '../src/utils/store';
import { CliError, ExitCode } from '../src/utils/exit';

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-test-'));
}

test('persistLogin writes config + auth, sets perms, gitignores .ef', async () => {
    const root = await tmpDir();
    try {
        // Mark this dir as a git repo so `persistLogin` writes a .gitignore.
        await fs.promises.mkdir(path.join(root, '.git'), { recursive: true });
        await persistLogin({
            projectRoot: root,
            apiUrl: 'https://example.test',
            apiKey: 'secret-test-key-1234567890',
            brandId: 99,
            syncRoot: 'elasticfunnels',
            saveMode: 'draft',
        });

        const cfg = JSON.parse(await fs.promises.readFile(path.join(root, '.ef', 'config.json'), 'utf8'));
        assert.equal(cfg.apiUrl, 'https://example.test');
        assert.equal(cfg.brandId, 99);
        assert.equal(cfg.syncRoot, 'elasticfunnels');
        assert.equal(cfg.syncLayout, 'nested');
        assert.equal(cfg.saveMode, 'draft');

        const authBody = await fs.promises.readFile(path.join(root, '.ef', 'auth'), 'utf8');
        assert.equal(authBody.trim(), 'secret-test-key-1234567890');

        if (process.platform !== 'win32') {
            const stat = await fs.promises.stat(path.join(root, '.ef', 'auth'));
            assert.equal(stat.mode & 0o777, 0o600, '.ef/auth must be chmod 600 on Unix');
        }

        const gitignore = await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8');
        assert.match(gitignore, /\.ef/);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('loadRuntime walks up from a subdirectory to find .ef/', async () => {
    const root = await tmpDir();
    try {
        await persistLogin({
            projectRoot: root,
            apiUrl: 'https://example.test',
            apiKey: 'k',
            brandId: 7,
        });
        const sub = path.join(root, 'a', 'b', 'c');
        await fs.promises.mkdir(sub, { recursive: true });
        const rt = await loadRuntime({ startDir: sub });
        assert.equal(rt.projectRoot, root);
        assert.equal(rt.config.brandId, 7);
        assert.equal(rt.apiKey, 'k');
        assert.equal(rt.brandRoot, path.join(root, 'elasticfunnels', '7'));
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('loadRuntime syncLayout flat puts brand root at syncRoot only', async () => {
    const root = await tmpDir();
    try {
        await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
        await fs.promises.writeFile(
            path.join(root, '.ef', 'config.json'),
            JSON.stringify({
                apiUrl: 'https://example.test',
                brandId: 4,
                syncRoot: 'elasticfunnels',
                syncLayout: 'flat',
                saveMode: 'draft',
            }),
        );
        await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k');
        const rt = await loadRuntime({ startDir: root });
        assert.equal(rt.brandRoot, path.join(root, 'elasticfunnels'));
        assert.equal(rt.config.syncLayout, 'flat');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('loadConfig throws CliError(Auth) when .ef is missing', async () => {
    const root = await tmpDir();
    try {
        await assert.rejects(
            () => loadConfig(root),
            (err: Error) => err instanceof CliError && err.code === ExitCode.Auth,
        );
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('loadApiKey throws CliError(Auth) when .ef/auth is missing', async () => {
    const root = await tmpDir();
    try {
        await assert.rejects(
            () => loadApiKey(root),
            (err: Error) => err instanceof CliError && err.code === ExitCode.Auth,
        );
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('clearLogin removes config + auth without touching synced files', async () => {
    const root = await tmpDir();
    try {
        await persistLogin({ projectRoot: root, apiUrl: 'https://x', apiKey: 'k', brandId: 1 });
        // Pretend the user has a synced page on disk.
        const synced = path.join(root, 'elasticfunnels', '1', 'pages', 'home.ef');
        await fs.promises.mkdir(path.dirname(synced), { recursive: true });
        await fs.promises.writeFile(synced, '<p>hello</p>');

        await clearLogin(root);

        assert.equal(await exists(path.join(root, '.ef', 'config.json')), false);
        assert.equal(await exists(path.join(root, '.ef', 'auth')), false);
        assert.equal(await exists(synced), true, 'synced files must NOT be touched by logout');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('findProjectRoot returns null when no .ef is found anywhere up the tree', async () => {
    const root = await tmpDir();
    try {
        // The temp dir lives inside /tmp which has no .ef anywhere up to /, so
        // findProjectRoot must return null for an isolated temp tree.
        assert.equal(findProjectRoot(root), null);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

async function exists(p: string): Promise<boolean> {
    try { await fs.promises.stat(p); return true; } catch { return false; }
}
