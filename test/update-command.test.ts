import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyInstall, npmPrefixFor } from '../src/commands/update';

/**
 * `classifyInstall` decides whether `ef update` is allowed to run a package
 * manager at all, so the interesting cases are the refusals — getting one of
 * them wrong means overwriting a source checkout or desyncing a project
 * lockfile. The paths below mirror where each manager actually installs.
 */

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-update-'));
}

/** Build a fake install tree and return the package dir. */
async function fakeInstall(root: string, rel: string, extras: string[] = []): Promise<string> {
    const dir = path.join(root, rel);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'package.json'), '{"name":"@elasticfunnels/cli"}');
    for (const e of extras) {
        if (e.endsWith('/')) await fs.promises.mkdir(path.join(dir, e), { recursive: true });
        else await fs.promises.writeFile(path.join(dir, e), '');
    }
    return dir;
}

test('a global npm install is updatable, and attributed to npm', async () => {
    const root = await tmpDir();
    try {
        const dir = await fakeInstall(root, 'usr/local/lib/node_modules/@elasticfunnels/cli');
        const got = classifyInstall(dir);
        assert.equal(got.kind, 'global');
        assert.equal(got.kind === 'global' && got.manager, 'npm');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('global installs are attributed to the manager that owns the path', async () => {
    const root = await tmpDir();
    try {
        const cases: Array<[string, string]> = [
            ['Library/pnpm/global/5/node_modules/@elasticfunnels/cli', 'pnpm'],
            ['.bun/install/global/node_modules/@elasticfunnels/cli', 'bun'],
            ['.config/yarn/global/node_modules/@elasticfunnels/cli', 'yarn'],
            ['.nvm/versions/node/v20.11.0/lib/node_modules/@elasticfunnels/cli', 'npm'],
            ['opt/homebrew/lib/node_modules/@elasticfunnels/cli', 'npm'],
        ];
        for (const [rel, manager] of cases) {
            const got = classifyInstall(await fakeInstall(root, rel));
            assert.equal(got.kind, 'global', rel);
            assert.equal(got.kind === 'global' && got.manager, manager, rel);
        }
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('a source checkout is never updatable — src/ and tsconfig.json are not published', async () => {
    const root = await tmpDir();
    try {
        // Same path shape as a global npm install; only the checkout-only files differ.
        const dir = await fakeInstall(root, 'usr/local/lib/node_modules/@elasticfunnels/cli', ['src/', 'tsconfig.json']);
        assert.equal(classifyInstall(dir).kind, 'source');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('src/ alone does not make it a checkout (a stray dir must not block updates)', async () => {
    const root = await tmpDir();
    try {
        const dir = await fakeInstall(root, 'usr/local/lib/node_modules/@elasticfunnels/cli', ['src/']);
        assert.equal(classifyInstall(dir).kind, 'global');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('an install under the working directory is project-local, not global', async () => {
    const root = await fs.promises.realpath(await tmpDir());
    const prevCwd = process.cwd();
    try {
        const project = path.join(root, 'my-project');
        const dir = await fakeInstall(project, 'node_modules/@elasticfunnels/cli');
        await fs.promises.mkdir(path.join(project, 'deep', 'nested'), { recursive: true });

        process.chdir(project);
        assert.equal(classifyInstall(dir).kind, 'local');

        // Still local from a subdirectory — node resolution walks up, so we must too.
        process.chdir(path.join(project, 'deep', 'nested'));
        assert.equal(classifyInstall(dir).kind, 'local');
    } finally {
        process.chdir(prevCwd);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('a project-local pnpm install is local and attributed to pnpm', async () => {
    const root = await fs.promises.realpath(await tmpDir());
    const prevCwd = process.cwd();
    try {
        const project = path.join(root, 'my-project');
        const dir = await fakeInstall(project, 'node_modules/.pnpm/@elasticfunnels+cli@0.12.0/node_modules/@elasticfunnels/cli');
        process.chdir(project);
        const got = classifyInstall(dir);
        assert.equal(got.kind, 'local');
        assert.equal(got.kind === 'local' && got.manager, 'pnpm');
    } finally {
        process.chdir(prevCwd);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('npmPrefixFor recovers the prefix that owns the install', () => {
    // Unix layout: <prefix>/lib/node_modules/<pkg>
    assert.equal(npmPrefixFor('/usr/local/lib/node_modules/@elasticfunnels/cli'), '/usr/local');
    assert.equal(npmPrefixFor('/opt/homebrew/lib/node_modules/@elasticfunnels/cli'), '/opt/homebrew');
    // A custom prefix — the case that would otherwise install a second copy.
    assert.equal(npmPrefixFor('/home/sam/opt/lib/node_modules/@elasticfunnels/cli'), '/home/sam/opt');
    // Windows layout has no lib/ level.
    assert.equal(npmPrefixFor('/Users/sam/AppData/Roaming/npm/node_modules/@elasticfunnels/cli'), '/Users/sam/AppData/Roaming/npm');
    // Not a node_modules layout at all → let npm decide.
    assert.equal(npmPrefixFor('/somewhere/random/cli'), null);
});

test('another project\'s node_modules is not local to this cwd', async () => {
    const root = await fs.promises.realpath(await tmpDir());
    const prevCwd = process.cwd();
    try {
        const here = path.join(root, 'here');
        await fs.promises.mkdir(here, { recursive: true });
        const dir = await fakeInstall(root, 'elsewhere/node_modules/@elasticfunnels/cli');
        process.chdir(here);
        assert.equal(classifyInstall(dir).kind, 'global', 'not under cwd, so not a project-local install');
    } finally {
        process.chdir(prevCwd);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
