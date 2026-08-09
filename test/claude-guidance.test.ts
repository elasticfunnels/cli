import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderClaudeSection, applyAgentGuidance, installBundledSkills } from '../src/commands/claude';

test('renderClaudeSection ports the .cursor template/backend-script/CRM docs', () => {
    const s = renderClaudeSection();
    for (const needle of ["asset('/main.css')", '@foreach(', '@component(', '@extends(', '<template-if', '[[ expression ]]', 'CRM helpers', 'COLLECTION_CODE', 'saveMode', 'efmeta']) {
        assert.ok(s.includes(needle), `guidance should mention ${needle}`);
    }
});

test('applyAgentGuidance creates, then updates in place (idempotent — no duplicate block)', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-claude-'));
    const target = path.join(dir, 'CLAUDE.md');
    try {
        assert.equal(await applyAgentGuidance(target), 'created');
        const first = await fs.promises.readFile(target, 'utf8');
        assert.equal(await applyAgentGuidance(target), 'updated');
        const second = await fs.promises.readFile(target, 'utf8');
        assert.equal(second, first, 'idempotent re-run produces identical content');
        assert.equal(second.match(/ef:begin/g)?.length, 1, 'exactly one managed block');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('installBundledSkills writes ef-page-events into .claude/skills/ with valid frontmatter', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-skills-'));
    try {
        const installed = await installBundledSkills(dir);
        assert.ok(installed.includes('ef-page-events'), `expected the ef-page-events skill; got ${JSON.stringify(installed)}`);
        const skillFile = path.join(dir, '.claude', 'skills', 'ef-page-events', 'SKILL.md');
        assert.ok(fs.existsSync(skillFile), 'SKILL.md written under .claude/skills/');
        const body = await fs.promises.readFile(skillFile, 'utf8');
        assert.ok(body.startsWith('---\n'), 'opens with YAML frontmatter');
        assert.match(body, /\nname: ef-page-events\b/, 'frontmatter carries the skill name');
        assert.match(body, /description:/, 'has a description for on-demand loading');
        // The load-bearing correctness content must be present.
        assert.match(body, /always pull first/i);
        assert.match(body, /page_variant/, 'LOAD-vs-REDIRECT guidance');
        assert.match(body, /compiled `script_rule`|script_rule/, 'the typed-condition trap');
        // Idempotent overwrite.
        assert.deepEqual(await installBundledSkills(dir), installed, 're-run installs the same set');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('applyAgentGuidance appends to an existing CLAUDE.md without clobbering it', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-claude-'));
    const target = path.join(dir, 'CLAUDE.md');
    try {
        await fs.promises.writeFile(target, '# My project\n\nExisting notes.\n');
        assert.equal(await applyAgentGuidance(target), 'appended');
        const out = await fs.promises.readFile(target, 'utf8');
        assert.ok(out.includes('# My project'), 'keeps existing content');
        assert.ok(out.includes('Existing notes.'));
        assert.ok(out.includes('ef:begin'), 'adds the managed block');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});
