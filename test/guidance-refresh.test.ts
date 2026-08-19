import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { CURSOR_FRONTMATTER, GUIDANCE_FILES, applyAgentGuidance, detectAgentTool, guidanceVersion, installBundledSkills, syncBundledSkills, refreshGuidanceIfStale, stampedGuidanceVersion } from '../src/commands/claude';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

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

test('the Cursor rule is refreshed alongside the other two, frontmatter intact', async () => {
    const dir = await tmp();
    try {
        const cursorRule = path.join(dir, GUIDANCE_FILES.cursor);
        await applyAgentGuidance(cursorRule, { frontmatter: CURSOR_FRONTMATTER });
        await applyAgentGuidance(path.join(dir, 'CLAUDE.md'));
        for (const f of [cursorRule, path.join(dir, 'CLAUDE.md')]) await backdate(f, '0.2.0');

        const refreshed = await refreshGuidanceIfStale(dir);
        assert.ok(refreshed.includes(GUIDANCE_FILES.cursor), `cursor rule not refreshed; got ${JSON.stringify(refreshed)}`);

        const after = await fs.promises.readFile(cursorRule, 'utf8');
        assert.equal(stampedGuidanceVersion(after), guidanceVersion());
        assert.ok(after.startsWith('---\n'), 'frontmatter survived the refresh');
        assert.equal(after.match(/ef:begin/g)?.length, 1, 'no duplicate block');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('ANY command re-stamps stale guidance, not just ef pull', async () => {
    // Claude Code gets this free — its SessionStart hook pulls. Cursor and
    // Codex have no hook, so a pull-only refresh left them reading guidance for
    // whatever version was current the last time someone happened to pull.
    // `ef config get` is entirely local, so this asserts the refresh without a
    // network call anywhere in it.
    const dir = await tmp();
    try {
        await fs.promises.mkdir(path.join(dir, '.ef'), { recursive: true });
        await fs.promises.writeFile(
            path.join(dir, '.ef', 'config.json'),
            JSON.stringify({ apiUrl: 'http://127.0.0.1:1', brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
        );
        await fs.promises.writeFile(path.join(dir, '.ef', 'auth'), 'k\n');

        const targets = ['CLAUDE.md', 'AGENTS.md', GUIDANCE_FILES.cursor];
        for (const f of targets) {
            await applyAgentGuidance(path.join(dir, f), { frontmatter: CURSOR_FRONTMATTER });
            await backdate(path.join(dir, f), '0.3.0');
        }

        await new Promise<void>((resolve) => {
            const child = spawn(process.execPath, [BIN_PATH, 'config', 'get'], {
                cwd: dir, env: { ...process.env, NO_COLOR: '1' },
            });
            child.on('close', () => resolve());
        });

        // The child runs the built CLI, which stamps the real package version.
        // `guidanceVersion()` in-process resolves against the test tree and
        // reports 0.0.0, so the shipped version is the thing to compare to.
        const shipped = (JSON.parse(
            await fs.promises.readFile(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
        ) as { version: string }).version;

        for (const f of targets) {
            const text = await fs.promises.readFile(path.join(dir, f), 'utf8');
            assert.notEqual(stampedGuidanceVersion(text), '0.3.0', `${f} was left stale`);
            assert.equal(stampedGuidanceVersion(text), shipped, `${f} was not re-stamped to the shipped version`);
        }
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('a project with no guidance files is not given any by a passing command', async () => {
    // The refresh runs after every command now, so the opt-out has to hold
    // there too — otherwise `ef init --no-claude` would silently undo itself.
    const dir = await tmp();
    try {
        await fs.promises.mkdir(path.join(dir, '.ef'), { recursive: true });
        await fs.promises.writeFile(
            path.join(dir, '.ef', 'config.json'),
            JSON.stringify({ apiUrl: 'http://127.0.0.1:1', brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
        );
        await fs.promises.writeFile(path.join(dir, '.ef', 'auth'), 'k\n');

        await new Promise<void>((resolve) => {
            const child = spawn(process.execPath, [BIN_PATH, 'config', 'get'], {
                cwd: dir, env: { ...process.env, NO_COLOR: '1' },
            });
            child.on('close', () => resolve());
        });

        assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
        assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
        assert.equal(fs.existsSync(path.join(dir, '.cursor')), false);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('detectAgentTool reads the environment, and admits when it cannot tell', () => {
    // It may only ever decide which row to highlight — never which files get
    // written — so a wrong guess must stay cosmetic.
    const saved = { ...process.env };
    try {
        for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CURSOR_TRACE_ID', 'CURSOR_AGENT', 'CODEX_SANDBOX', 'CODEX_HOME']) delete process.env[k];
        assert.equal(detectAgentTool(), null);

        process.env.CLAUDECODE = '1';
        assert.equal(detectAgentTool(), 'claude');
        delete process.env.CLAUDECODE;

        process.env.CURSOR_TRACE_ID = 'abc';
        assert.equal(detectAgentTool(), 'cursor');
        delete process.env.CURSOR_TRACE_ID;

        process.env.CODEX_HOME = '/tmp';
        assert.equal(detectAgentTool(), 'codex');
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test('a skill added in a later CLI reaches a project that already opted into skills', async () => {
    // The failure this pins down: guidance re-stamps itself, so an upgraded
    // CLAUDE.md starts saying "use the ef-stats skill" — while the skill file
    // itself was only ever written by `ef init` / `ef claude`. The project ends
    // up pointing at a skill it does not have, and nothing says so.
    const dir = await tmp();
    try {
        await installBundledSkills(dir);
        const stats = path.join(dir, '.claude', 'skills', 'ef-stats', 'SKILL.md');
        assert.ok(fs.existsSync(stats), 'precondition: the bundle ships ef-stats');
        await fs.promises.rm(path.join(dir, '.claude', 'skills', 'ef-stats'), { recursive: true, force: true });

        const changed = await syncBundledSkills(dir);
        assert.ok(changed.includes('ef-stats'), `ef-stats not restored; got ${JSON.stringify(changed)}`);
        assert.ok(fs.existsSync(stats), 'the missing skill is delivered');

        // Second pass writes nothing: the common path must not churn mtimes.
        assert.deepEqual(await syncBundledSkills(dir), []);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('an edited skill is restored to the shipped copy, since it is managed', async () => {
    const dir = await tmp();
    try {
        await installBundledSkills(dir);
        const target = path.join(dir, '.claude', 'skills', 'ef-stats', 'SKILL.md');
        await fs.promises.writeFile(target, '---\nname: ef-stats\n---\nstale hand edit\n');

        assert.ok((await syncBundledSkills(dir)).includes('ef-stats'));
        assert.match(await fs.promises.readFile(target, 'utf8'), /America\/Los_Angeles/, 'shipped content is back');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('a project that never opted into skills is not given any', async () => {
    // `.claude/skills/` absent means `ef init --no-claude`, or a deliberate
    // removal. Either way it is a choice, and the refresh must not undo it.
    const dir = await tmp();
    try {
        assert.deepEqual(await syncBundledSkills(dir), []);
        assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('a project with no guidance is never given any by the refresh', async () => {
    // The load-bearing half of the opt-out. "No CLAUDE.md" is two situations
    // that look identical on disk — a deliberate refusal, and a project bound
    // before the guidance existed — so creating one silently would override a
    // real choice in the first case. `ef status` mentions it instead.
    const dir = await tmp();
    try {
        assert.deepEqual(await refreshGuidanceIfStale(dir), []);
        for (const rel of Object.values(GUIDANCE_FILES)) {
            assert.equal(fs.existsSync(path.join(dir, rel)), false, `${rel} was created unasked`);
        }
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});
