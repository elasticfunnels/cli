import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    findSibling,
    flattenFolders,
    isNoFolder,
    matchPages,
    normalizeFolderColor,
    resolveFolder,
} from '../src/commands/folders';
import { Page, PageFolder } from '../src/api/types';
import { CliError, ExitCode } from '../src/utils/exit';

/**
 * Folder references are resolved client-side before a write, so a wrong match
 * files pages into the wrong folder silently. The resolution rules are tested.
 */

function caught(fn: () => unknown): CliError {
    try { fn(); } catch (err) {
        assert.ok(err instanceof CliError, `expected a CliError, got ${err}`);
        return err;
    }
    throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' });
}

const tree: PageFolder[] = [
    { id: 1, name: 'Kits', parent_id: null, pages_count: 0, children: [
        { id: 3, name: 'Supplement VSL funnel', parent_id: 1, pages_count: 20, children: [] },
        { id: 4, name: 'Other', parent_id: 1, pages_count: 2, children: [] },
    ] },
    { id: 2, name: 'Page templates', parent_id: null, pages_count: 0, children: [
        { id: 5, name: 'Other', parent_id: 2, pages_count: 1, children: [] },
    ] },
];

test('the tree flattens depth-first with paths and depths', () => {
    const flat = flattenFolders(tree);
    assert.deepEqual(flat.map(f => f.path), [
        'Kits', 'Kits/Supplement VSL funnel', 'Kits/Other', 'Page templates', 'Page templates/Other',
    ]);
    assert.deepEqual(flat.map(f => f.depth), [0, 1, 1, 0, 1]);
    assert.equal(flat[1].pages_count, 20);
});

test('folders resolve by id, by unique name and by path, ignoring case', () => {
    const flat = flattenFolders(tree);
    assert.equal(resolveFolder(flat, '3').id, 3);
    assert.equal(resolveFolder(flat, 'supplement vsl funnel').id, 3);
    assert.equal(resolveFolder(flat, 'Page templates / Other').id, 5);
    assert.equal(resolveFolder(flat, 'kits/other').id, 4);
});

test('an ambiguous name is refused and names the candidate paths', () => {
    const err = caught(() => resolveFolder(flattenFolders(tree), 'Other'));
    assert.equal(err.code, ExitCode.Validation);
    assert.match(err.message, /Kits\/Other/);
    assert.match(err.message, /Page templates\/Other/);
});

test('an unknown folder is a not-found error', () => {
    assert.equal(caught(() => resolveFolder(flattenFolders(tree), 'Nope')).code, ExitCode.NotFound);
    assert.equal(caught(() => resolveFolder(flattenFolders(tree), '  ')).code, ExitCode.Validation);
});

test('"none" and friends mean no folder', () => {
    for (const v of ['none', 'NULL', '-', ' none ']) assert.ok(isNoFolder(v));
    assert.ok(!isNoFolder('Kits'));
});

test('siblings are matched under their own parent only', () => {
    const flat = flattenFolders(tree);
    assert.equal(findSibling(flat, null, 'kits')?.id, 1);
    assert.equal(findSibling(flat, 2, 'other')?.id, 5);
    assert.equal(findSibling(flat, null, 'Other'), undefined);
});

test('colours must be #RRGGBB, the only form the server accepts', () => {
    assert.equal(normalizeFolderColor('#AABBCC'), '#aabbcc');
    assert.equal(normalizeFolderColor('aabbcc'), '#aabbcc');
    assert.equal(caught(() => normalizeFolderColor('#abc')).code, ExitCode.Validation);
    assert.equal(caught(() => normalizeFolderColor('blue')).code, ExitCode.Validation);
});

test('page refs match by slug (all variants), variant slug or id, and report misses', () => {
    const pages = [
        { id: 10, slug: 'kits/a/vsl', variant_slug: null },
        { id: 11, slug: 'kits/a/vsl', variant_slug: 'kits/a/vsl-b' },
        { id: 12, slug: 'kits/a/order', variant_slug: null },
    ] as unknown as Page[];
    const r = matchPages(pages, ['kits/a/vsl', '12', 'kits/a/vsl-b', 'missing']);
    assert.deepEqual(r.matched.map(p => p.id).sort(), [10, 11, 12]);
    assert.deepEqual(r.missing, ['missing']);
});
