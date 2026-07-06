import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderClaudeSection, applyClaudeGuidance } from '../src/commands/claude';

test('renderClaudeSection ports the .cursor template/backend-script/CRM docs', () => {
    const s = renderClaudeSection();
    for (const needle of ["asset('/main.css')", '@foreach(', '@component(', '@extends(', '<template-if', '[[ expression ]]', 'CRM helpers', 'COLLECTION_CODE', 'saveMode', 'efmeta']) {
        assert.ok(s.includes(needle), `guidance should mention ${needle}`);
    }
});

test('applyClaudeGuidance creates, then updates in place (idempotent — no duplicate block)', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-claude-'));
    const target = path.join(dir, 'CLAUDE.md');
    try {
        assert.equal(await applyClaudeGuidance(target), 'created');
        const first = await fs.promises.readFile(target, 'utf8');
        assert.equal(await applyClaudeGuidance(target), 'updated');
        const second = await fs.promises.readFile(target, 'utf8');
        assert.equal(second, first, 'idempotent re-run produces identical content');
        assert.equal(second.match(/ef:begin/g)?.length, 1, 'exactly one managed block');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('applyClaudeGuidance appends to an existing CLAUDE.md without clobbering it', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-claude-'));
    const target = path.join(dir, 'CLAUDE.md');
    try {
        await fs.promises.writeFile(target, '# My project\n\nExisting notes.\n');
        assert.equal(await applyClaudeGuidance(target), 'appended');
        const out = await fs.promises.readFile(target, 'utf8');
        assert.ok(out.includes('# My project'), 'keeps existing content');
        assert.ok(out.includes('Existing notes.'));
        assert.ok(out.includes('ef:begin'), 'adds the managed block');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});
