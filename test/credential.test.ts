import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliError, ExitCode } from '../src/utils/exit';
import { augmentAuthError, credentialKind, reauthHint, storedCredentialKind } from '../src/utils/credential';

/**
 * The point of these: a revoked device and a stale brand key both surface as
 * HTTP 401, but the fixes have nothing in common. Telling someone whose device
 * was disconnected to "check your API key" sends them looking for a credential
 * they never had.
 */

async function boundProject(authContents: string | null): Promise<string> {
    const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-cred-')));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ brandId: 1, apiUrl: 'https://x', syncRoot: 'elasticfunnels' }));
    if (authContents !== null) await fs.promises.writeFile(path.join(root, '.ef', 'auth'), authContents);
    return root;
}

test('credentialKind separates device tokens from legacy brand keys', () => {
    assert.equal(credentialKind('efc_abc123'), 'device');
    assert.equal(credentialKind('  efc_abc123\n'), 'device', 'tolerates the trailing newline saveApiKey writes');
    assert.equal(credentialKind('sk-live-whatever'), 'legacy');
    assert.equal(credentialKind(''), 'legacy', 'unknown shape falls back to the legacy advice');
});

test('each credential kind gets its own fix, and both name a runnable command', () => {
    const device = reauthHint('device');
    assert.match(device, /Connected devices/, 'device tokens are revoked from the devices list');
    assert.match(device, /ef login/);
    assert.doesNotMatch(device, /Settings → All Settings → API/, 'must not send them to the API key page');

    const legacy = reauthHint('legacy');
    assert.match(legacy, /Settings → All Settings → API/);
});

test('storedCredentialKind reads the kind off disk', async () => {
    const root = await boundProject('efc_tok\n');
    try {
        assert.equal(storedCredentialKind(root), 'device');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('storedCredentialKind stays silent when there is nothing to read', async () => {
    const missing = await boundProject(null);
    const empty = await boundProject('   \n');
    try {
        assert.equal(storedCredentialKind(missing), null, 'no auth file');
        assert.equal(storedCredentialKind(empty), null, 'empty auth file');
        assert.equal(storedCredentialKind(path.join(missing, 'nope', 'nope')), null, 'unreadable path');
    } finally {
        await fs.promises.rm(missing, { recursive: true, force: true });
        await fs.promises.rm(empty, { recursive: true, force: true });
    }
});

test('augmentAuthError only touches auth failures', () => {
    const conflict = new CliError(ExitCode.Conflict, 'Changes rejected');
    assert.equal(augmentAuthError(conflict), conflict, 'returned unchanged, same object');

    const server = new CliError(ExitCode.Server, 'HTTP 500');
    assert.equal(augmentAuthError(server).message, 'HTTP 500');
});

test('augmentAuthError does not stack a second instruction on messages that already have one', () => {
    const alreadyGuided = new CliError(ExitCode.Auth, 'No ElasticFunnels API key on disk. Run "ef init".');
    assert.equal(augmentAuthError(alreadyGuided).message, alreadyGuided.message);
});
