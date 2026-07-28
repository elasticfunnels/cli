#!/usr/bin/env node
// LIVE two-editor conflict harness. Simulates two people working the same brand
// from two separate folders (both bound to the same brand) — the real lost-update
// scenario — against the actual backend. Verifies: new-page creation, refuse-on-
// drift, git-style 3-way merge, conflict markers, and force. Cleans up after.
//
// Usage:
//   node scripts/conflict-harness.mjs <editor1Dir> <editor2Dir>
//   EF_BIN=/path/to/ef.js node scripts/conflict-harness.mjs <dir1> <dir2>

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.EF_BIN || path.resolve(HERE, '..', 'bin', 'ef.js');
const E1 = path.resolve(process.argv[2] || '');
const E2 = path.resolve(process.argv[3] || '');
if (!fs.existsSync(path.join(E1, '.ef/config.json')) || !fs.existsSync(path.join(E2, '.ef/config.json'))) {
    console.error('Both dirs must be bound projects (ef init). Usage: conflict-harness.mjs <dir1> <dir2>');
    process.exit(2);
}
const cfg = (d) => JSON.parse(fs.readFileSync(path.join(d, '.ef/config.json'), 'utf8'));
const brandRoot = (d) => (cfg(d).syncLayout === 'nested' ? path.join(d, cfg(d).syncRoot, String(cfg(d).brandId)) : path.join(d, cfg(d).syncRoot));
const SLUG = `zzconflict-${Date.now()}`;
const pageFile = (d) => path.join(brandRoot(d), 'pages', `${SLUG}.ef`);

function ef(cwd, args) {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function editBody(file, body) {
    const efmeta = fs.readFileSync(file, 'utf8').split('\n')[0];
    fs.writeFileSync(file, `${efmeta}\n${body}`);
}
const bodyOf = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n');

const results = [];
function check(name, fn) {
    try { fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
    catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log(`conflict harness — E1=${E1}\n                   E2=${E2}\n                   page=${SLUG} (brand #${cfg(E1).brandId})\n`);

try {
    // E1 creates a brand-new page by pushing a local file (exercises create path + snapshot).
    check('E1 creates a new page via push (new-page creation)', () => {
        fs.mkdirSync(path.join(brandRoot(E1), 'pages'), { recursive: true });
        fs.writeFileSync(pageFile(E1), 'line1\nline2\nline3\n');
        const r = ef(E1, ['push', `pages/${SLUG}.ef`, '--json']);
        assert(r.code === 0, `push exit ${r.code}; ${r.err}`);
        const id = JSON.parse(r.out).pushed[0].serverId;
        assert(id, 'server id assigned');
        // Baseline snapshot must exist so future edits are drift-protected.
        assert(fs.existsSync(path.join(brandRoot(E1), '.ef-state', 'snapshots', 'page', `${id}.bin`)), 'baseline snapshot written on create');
    });

    // E2 pulls the page → gets its own baseline.
    check('E2 pulls the page', () => {
        const r = ef(E2, ['pull', 'page', SLUG]);
        assert(r.code === 0, `pull exit ${r.code}; ${r.err}`);
        assert(fs.existsSync(pageFile(E2)), 'E2 has the page');
    });

    // E1 edits line 3 and pushes → server advances.
    check('E1 edits + pushes (server advances)', () => {
        editBody(pageFile(E1), 'line1\nline2\nE1-EDIT\n');
        const r = ef(E1, ['push', `pages/${SLUG}.ef`, '--json']);
        assert(r.code === 0, `E1 push exit ${r.code}; ${r.err}`);
    });

    // E2 (stale) edits line 1 and pushes → REJECTED (server moved since E2 pulled).
    check('E2 stale push is REJECTED with the exact message', () => {
        editBody(pageFile(E2), 'E2-EDIT\nline2\nline3\n');
        const r = ef(E2, ['push', `pages/${SLUG}.ef`, '--json']);
        assert(r.code === 4, `expected exit 4, got ${r.code}; ${r.err}`);
        const j = JSON.parse(r.out);
        assert(j.ok === false && j.conflicts === 1, `expected 1 conflict, got ${JSON.stringify(j)}`);
        assert(/Changes rejected/.test(j.pushed[0].note || ''), `message: ${j.pushed[0].note}`);
    });

    // E2 merges the server version in (non-overlapping → clean).
    check('E2 pull --merge cleanly combines both edits', () => {
        const r = ef(E2, ['pull', 'page', SLUG, '--merge']);
        assert(r.code === 0, `merge pull exit ${r.code}; ${r.err}`);
        assert(bodyOf(pageFile(E2)) === 'E2-EDIT\nline2\nE1-EDIT\n', `merged body was: ${JSON.stringify(bodyOf(pageFile(E2)))}`);
    });

    // E2 pushes the merged result → succeeds.
    check('E2 pushes the merged result successfully', () => {
        const r = ef(E2, ['push', `pages/${SLUG}.ef`, '--json']);
        assert(r.code === 0, `E2 merged push exit ${r.code}; ${r.err}`);
    });

    // E1 pulls and sees the merged version (both edits present).
    check('E1 pulls and sees both edits', () => {
        const r = ef(E1, ['pull', 'page', SLUG, '--force']);
        assert(r.code === 0, `E1 re-pull exit ${r.code}; ${r.err}`);
        const b = bodyOf(pageFile(E1));
        assert(/E1-EDIT/.test(b) && /E2-EDIT/.test(b), `E1 body missing an edit: ${JSON.stringify(b)}`);
    });

    // Overlapping edits → conflict markers → push refused until resolved.
    check('overlapping edits → conflict markers → push refused → resolve → push', () => {
        // Both pull fresh, then edit the SAME line.
        ef(E1, ['pull', 'page', SLUG, '--force']);
        ef(E2, ['pull', 'page', SLUG, '--force']);
        editBody(pageFile(E1), 'top\nE1-SAME\nbottom\n');
        assert(ef(E1, ['push', `pages/${SLUG}.ef`]).code === 0, 'E1 sets up the line');
        editBody(pageFile(E2), 'top\nE2-SAME\nbottom\n');
        const merge = ef(E2, ['pull', 'page', SLUG, '--merge']);
        assert(merge.code === 0, `merge exit ${merge.code}; ${merge.err}`);
        assert(/<{7}/.test(fs.readFileSync(pageFile(E2), 'utf8')), 'conflict markers present');
        const refused = ef(E2, ['push', `pages/${SLUG}.ef`, '--json']);
        assert(refused.code === 4, `expected refusal, got ${refused.code}`);
        assert(/conflict markers/.test(JSON.parse(refused.out).pushed[0].note || ''), 'refused for markers');
        editBody(pageFile(E2), 'top\nRESOLVED\nbottom\n');
        assert(ef(E2, ['push', `pages/${SLUG}.ef`]).code === 0, 'resolved push succeeds');
    });
} finally {
    // Cleanup: delete the page from the server + both local files.
    const del = ef(E1, ['pages', 'delete', SLUG, '--force']);
    console.log(`\ncleanup: delete page ${SLUG} → exit ${del.code}`);
    for (const d of [E1, E2]) { try { fs.rmSync(pageFile(d), { force: true }); } catch { /* ignore */ } }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) { for (const f of failed) console.log(`  - ${f.name}: ${f.err}`); process.exit(1); }
console.log('✓ all conflict-harness checks passed');
