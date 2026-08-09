import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyAgentGuidance, guidanceVersion, refreshGuidanceIfStale, stampedGuidanceVersion } from '../src/commands/claude';

/**
 * The guidance documents how the CLI behaves, so after an upgrade a project's
 * CLAUDE.md can describe a tool that no longer exists. An agent has no way to
 * tell it is reading stale instructions — it just follows them. So the block is
 * version-stamped and re-stamped by any command that loads the project.
 */

async function tmp(): Promise<string> {
    return await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-refresh-')));
}

/** Rewrite a file's stamp to fake a block written by an older CLI. */
async function backdate(target: string, version: string): Promise<void> {
    const text = await fs.promises.readFile(target, 'utf8');
    await fs.promises.writeFile(target, text.replace(/ef:begin v[0-9][^\s]*/, `ef:begin v${version}`));
}

test('a block written by an older CLI is re-stamped and rewritten', async () => {
    const dir = await tmp();
    try {
        const claudeMd = path.join(dir, 'CLAUDE.md');
        await applyAgentGuidance(claudeMd);
        await backdate(claudeMd, '0.1.0');

        const updated = await refreshGuidanceIfStale(dir);
        assert.deepEqual(updated, ['CLAUDE.md']);
        assert.equal(stampedGuidanceVersion(await fs.promises.readFile(claudeMd, 'utf8')), guidanceVersion());
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('an up-to-date block is left completely alone', async () => {
    const dir = await tmp();
    try {
        const claudeMd = path.join(dir, 'CLAUDE.md');
        await applyAgentGuidance(claudeMd);
        const before = await fs.promises.readFile(claudeMd, 'utf8');

        assert.deepEqual(await refreshGuidanceIfStale(dir), [], 'no work reported');
        assert.equal(await fs.promises.readFile(claudeMd, 'utf8'), before, 'byte-identical');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('a project that opted out of guidance is never given a file', async () => {
    // `ef init --no-claude` leaves no CLAUDE.md. Refresh must not create one.
    const dir = await tmp();
    try {
        assert.deepEqual(await refreshGuidanceIfStale(dir), []);
        assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
        assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('a hand-written CLAUDE.md with no managed block is not touched', async () => {
    const dir = await tmp();
    const claudeMd = path.join(dir, 'CLAUDE.md');
    try {
        await fs.promises.writeFile(claudeMd, '# My own notes\n\nNothing to do with ElasticFunnels.\n');
        assert.deepEqual(await refreshGuidanceIfStale(dir), []);
        assert.equal(await fs.promises.readFile(claudeMd, 'utf8'), '# My own notes\n\nNothing to do with ElasticFunnels.\n');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('the pre-versioning marker is recognised and upgraded, not duplicated', async () => {
    // Blocks written by <= 0.14.0 have no version in the begin marker.
    const dir = await tmp();
    const claudeMd = path.join(dir, 'CLAUDE.md');
    try {
        await applyAgentGuidance(claudeMd);
        const text = await fs.promises.readFile(claudeMd, 'utf8');
        await fs.promises.writeFile(claudeMd, text.replace(/ef:begin v[0-9][^\s]*/, 'ef:begin'));

        assert.deepEqual(await refreshGuidanceIfStale(dir), ['CLAUDE.md']);
        const after = await fs.promises.readFile(claudeMd, 'utf8');
        assert.equal(after.match(/ef:begin/g)?.length, 1, 'still exactly one block');
        assert.equal(stampedGuidanceVersion(after), guidanceVersion());
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('both CLAUDE.md and AGENTS.md are refreshed when both exist', async () => {
    const dir = await tmp();
    try {
        for (const f of ['CLAUDE.md', 'AGENTS.md']) {
            await applyAgentGuidance(path.join(dir, f));
            await backdate(path.join(dir, f), '0.2.0');
        }
        assert.deepEqual((await refreshGuidanceIfStale(dir)).sort(), ['AGENTS.md', 'CLAUDE.md']);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});
