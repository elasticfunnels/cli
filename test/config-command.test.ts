import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

async function setupProject(saveMode: 'draft' | 'direct' = 'draft'): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-cfg-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl: 'https://app.example', brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    return root;
}

function runEf(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
    const r = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function readSaveMode(root: string): string {
    return JSON.parse(fs.readFileSync(path.join(root, '.ef', 'config.json'), 'utf8')).saveMode;
}

test('config set saveMode direct rewrites .ef/config.json', async () => {
    const root = await setupProject('draft');
    try {
        const res = runEf(root, ['config', 'set', 'saveMode', 'direct']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(readSaveMode(root), 'direct');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('config get saveMode prints the value', async () => {
    const root = await setupProject('direct');
    try {
        const res = runEf(root, ['config', 'get', 'saveMode']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(res.stdout.trim(), 'direct');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('config set rejects an invalid saveMode value', async () => {
    const root = await setupProject('draft');
    try {
        const res = runEf(root, ['config', 'set', 'saveMode', 'bogus']);
        assert.equal(res.status, 2, 'validation exit code');
        assert.equal(readSaveMode(root), 'draft', 'config unchanged on rejection');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('config set refuses a non-settable key (brandId)', async () => {
    const root = await setupProject('draft');
    try {
        const res = runEf(root, ['config', 'set', 'brandId', '9']);
        assert.equal(res.status, 2);
        assert.match(res.stderr, /Cannot set "brandId"/);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('config get --json prints the full config', async () => {
    const root = await setupProject('direct');
    try {
        const res = runEf(root, ['config', 'get', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const cfg = JSON.parse(res.stdout);
        assert.equal(cfg.brandId, 7);
        assert.equal(cfg.saveMode, 'direct');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
