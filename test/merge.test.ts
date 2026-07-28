import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { threeWayMerge, hasConflictMarkers, unifiedDiff, hasGit } from '../src/sync/merge';

test('git is available for the hunk-level merge path', () => {
    assert.equal(hasGit(), true, 'these tests assume git on PATH');
});

test('threeWayMerge: only the server changed → take server (no conflict)', () => {
    const base = 'a\nb\nc\n';
    const local = 'a\nb\nc\n';        // unchanged
    const server = 'a\nB\nc\n';        // server edited line 2
    const r = threeWayMerge(base, local, server);
    assert.equal(r.hadConflicts, false);
    assert.equal(r.merged, server);
});

test('threeWayMerge: only local changed → keep local (no conflict)', () => {
    const base = 'a\nb\nc\n';
    const local = 'a\nLOCAL\nc\n';
    const server = 'a\nb\nc\n';
    const r = threeWayMerge(base, local, server);
    assert.equal(r.hadConflicts, false);
    assert.equal(r.merged, local);
});

test('threeWayMerge: non-overlapping edits auto-merge cleanly', () => {
    const base = 'line1\nline2\nline3\n';
    const local = 'LOCAL1\nline2\nline3\n';   // changed line 1
    const server = 'line1\nline2\nSERVER3\n'; // changed line 3
    const r = threeWayMerge(base, local, server);
    assert.equal(r.hadConflicts, false, 'non-overlapping edits merge without conflict');
    assert.equal(r.merged, 'LOCAL1\nline2\nSERVER3\n');
    assert.equal(hasConflictMarkers(r.merged), false);
});

test('threeWayMerge: overlapping edits produce git-style conflict markers', () => {
    const base = 'a\nline2\nc\n';
    const local = 'a\nLOCAL2\nc\n';
    const server = 'a\nSERVER2\nc\n';
    const r = threeWayMerge(base, local, server, { local: 'mine', server: 'theirs' });
    assert.equal(r.hadConflicts, true);
    assert.ok(hasConflictMarkers(r.merged), 'has <<< === >>> markers');
    assert.match(r.merged, /<{7} mine/);
    assert.match(r.merged, /={7}/);
    assert.match(r.merged, />{7} theirs/);
    assert.match(r.merged, /LOCAL2/);
    assert.match(r.merged, /SERVER2/);
});

test('threeWayMerge: identical local and server → clean, no markers', () => {
    const r = threeWayMerge('base\n', 'same\n', 'same\n');
    assert.equal(r.hadConflicts, false);
    assert.equal(r.merged, 'same\n');
});

test('hasConflictMarkers detects only real marker sets', () => {
    assert.equal(hasConflictMarkers('<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n'), true);
    assert.equal(hasConflictMarkers('plain content\nno markers\n'), false);
    assert.equal(hasConflictMarkers('a < b and c > d, 7 of them: =======\n'), false, 'partial/incomplete markers are not a conflict');
});

test('unifiedDiff shows changes and is empty for identical input', () => {
    assert.equal(unifiedDiff('same\n', 'same\n'), '');
    const d = unifiedDiff('old line\n', 'new line\n', 'server', 'local');
    assert.match(d, /-old line/);
    assert.match(d, /\+new line/);
});
