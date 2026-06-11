import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Regression guard: the API key written to .ef/auth must NEVER appear in
 * stdout or stderr from any CLI command. If a future change accidentally
 * adds the key to a log line, this test fails loudly.
 *
 * We run the real `bin/ef.js` against a fake brand root with a known
 * API key, then assert the key never shows up in any output.
 */

const FAKE_KEY = 'redacted-secret-token-' + Math.random().toString(36).slice(2, 12);

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-secrets-'));
}

// __dirname at runtime resolves to <cli>/out-test/test/. The actual bin lives
// at <cli>/bin/ef.js — two levels up from the compiled test directory.
const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

function runEf(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
    const res = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

test('whoami never echoes the raw API key, only a prefix', async () => {
    const root = await tmpDir();
    try {
        // Hand-write .ef/ so we don't need the network for `ef init`.
        await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
        await fs.promises.writeFile(
            path.join(root, '.ef', 'config.json'),
            JSON.stringify({ apiUrl: 'https://example.test', brandId: 1, syncRoot: 'elasticfunnels', saveMode: 'draft' }),
        );
        await fs.promises.writeFile(path.join(root, '.ef', 'auth'), FAKE_KEY + '\n');

        const result = runEf(root, ['whoami']);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr=${result.stderr}`);
        assert.ok(!result.stdout.includes(FAKE_KEY), 'API key must not appear in stdout');
        assert.ok(!result.stderr.includes(FAKE_KEY), 'API key must not appear in stderr');
        // The masked prefix should be present in stderr instead.
        assert.match(result.stderr, /API key/);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('whoami --json never includes the raw API key', async () => {
    const root = await tmpDir();
    try {
        await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
        await fs.promises.writeFile(
            path.join(root, '.ef', 'config.json'),
            JSON.stringify({ apiUrl: 'https://example.test', brandId: 1, syncRoot: 'elasticfunnels', saveMode: 'draft' }),
        );
        await fs.promises.writeFile(path.join(root, '.ef', 'auth'), FAKE_KEY + '\n');

        const result = runEf(root, ['whoami', '--json']);
        assert.equal(result.status, 0);
        assert.ok(!result.stdout.includes(FAKE_KEY), 'API key must not appear in JSON stdout');
        const parsed = JSON.parse(result.stdout);
        assert.ok(typeof parsed.apiKeyPrefix === 'string');
        assert.ok(!parsed.apiKeyPrefix.includes(FAKE_KEY));
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('non-TTY init without --api-key fails fast instead of hanging', async () => {
    const root = await tmpDir();
    try {
        // Fake a non-TTY: `spawnSync` already gives us a non-TTY stdin. Run
        // with a hard timeout so a regression that re-introduces the hang
        // would fail the test rather than hang CI.
        const res = spawnSync(process.execPath, [BIN_PATH, 'init', '--api-url', 'https://example.test'], {
            cwd: root,
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, EF_API_KEY: '', NO_COLOR: '1' },
        });
        assert.notEqual(res.status, null, 'init must exit, not hang (signal: ' + res.signal + ')');
        assert.equal(res.status, 2, `expected validation exit, got ${res.status}\nstderr=${res.stderr}`);
        assert.match(res.stderr, /(API key|stdin|TTY)/i);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('init --non-interactive without --api-key fails with validation, not auth', async () => {
    const root = await tmpDir();
    try {
        const res = spawnSync(process.execPath, [BIN_PATH, 'init', '--non-interactive'], {
            cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, EF_API_KEY: '', NO_COLOR: '1' },
        });
        assert.equal(res.status, 2);
        assert.match(res.stderr, /api-key/i);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
