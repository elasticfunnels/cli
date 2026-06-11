import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import {
    relPathForPage,
    relPathForComponent,
    relPathForScript,
    relPathForAsset,
    safeJoinBrandRoot,
    pageEffectiveSlug,
    isTextAssetPath,
    kindFromRel,
} from '../src/sync/paths';
import { normalizeAssetPath } from '../src/api/client';

test('relPathForPage uses slug, falling back to variant_slug, then page-<id>', () => {
    assert.equal(relPathForPage({ slug: 'home', variant_slug: null, id: 1 }), 'pages/home.ef');
    assert.equal(relPathForPage({ slug: null, variant_slug: 'v3/home', id: 2 }), 'pages/v3/home.ef');
    assert.equal(relPathForPage({ slug: null, variant_slug: null, id: 17 }), 'pages/page-17.ef');
});

test('pageEffectiveSlug strips leading and trailing slashes', () => {
    assert.equal(pageEffectiveSlug({ slug: '/leading', variant_slug: null, id: 1 }), 'leading');
    assert.equal(pageEffectiveSlug({ slug: 'trailing/', variant_slug: null, id: 1 }), 'trailing');
});

test('relPathForComponent uses code, then name, then component-<id>', () => {
    assert.equal(relPathForComponent({ code: 'header', name: 'Header', id: 1 }), 'components/header.ef');
    assert.equal(relPathForComponent({ code: null, name: 'Footer Bar', id: 2 }), 'components/Footer Bar.ef');
    assert.equal(relPathForComponent({ code: null, name: '', id: 7 }), 'components/component-7.ef');
});

test('relPathForScript uses code, then script-<id>', () => {
    assert.equal(relPathForScript({ code: 'welcome-email', id: 1 }), 'scripts/welcome-email.js');
    assert.equal(relPathForScript({ code: '', id: 9 }), 'scripts/script-9.js');
});

test('relPathForAsset preserves nested file_path under assets/', () => {
    assert.equal(
        relPathForAsset({ file_path: 'images/logo.png', file_name: 'logo.png', id: 1 }),
        'assets/images/logo.png',
    );
    assert.equal(
        relPathForAsset({ file_path: '/leading-slash/file.css', file_name: 'file.css', id: 2 }),
        'assets/leading-slash/file.css',
    );
});

test('safeJoinBrandRoot allows nested writes within the brand root', () => {
    const root = path.resolve('/tmp/ef-brand');
    const got = safeJoinBrandRoot(root, 'pages/about/index.ef');
    assert.ok(got.startsWith(root + path.sep), `expected ${got} to be inside ${root}`);
    assert.ok(got.endsWith(path.normalize('pages/about/index.ef')));
});

test('safeJoinBrandRoot blocks ../ traversal attempts', () => {
    const root = path.resolve('/tmp/ef-brand');
    assert.throws(() => safeJoinBrandRoot(root, '../escape.ef'), /outside brand root/);
    assert.throws(() => safeJoinBrandRoot(root, 'pages/../../escape.ef'), /outside brand root/);
    assert.throws(() => safeJoinBrandRoot(root, '../../etc/passwd'), /outside brand root/);
});

test('safeJoinBrandRoot strips leading slashes so absolute-looking paths land inside the brand root', () => {
    // A server payload claiming `/etc/passwd` is treated as relative
    // `etc/passwd` under the brand root — it cannot escape.
    const root = path.resolve('/tmp/ef-brand');
    const got = safeJoinBrandRoot(root, '/etc/passwd');
    assert.ok(got.startsWith(root + path.sep), `expected ${got} to be inside ${root}`);
    assert.ok(got.endsWith(path.normalize('etc/passwd')));
});

test('safeJoinBrandRoot normalizes Windows-style backslashes', () => {
    const root = path.resolve('/tmp/ef-brand');
    const got = safeJoinBrandRoot(root, 'pages\\nested\\file.ef');
    assert.ok(got.endsWith(path.normalize('pages/nested/file.ef')));
});

test('normalizeAssetPath collapses slashes and strips leading separators', () => {
    assert.equal(normalizeAssetPath('/foo//bar///baz.txt'), 'foo/bar/baz.txt');
    assert.equal(normalizeAssetPath('foo\\bar\\baz.txt'), 'foo/bar/baz.txt');
    assert.equal(normalizeAssetPath(''), '');
    assert.equal(normalizeAssetPath('/'), '');
});

test('isTextAssetPath classifies common extensions correctly', () => {
    assert.equal(isTextAssetPath('foo.css'), true);
    assert.equal(isTextAssetPath('foo.js'), true);
    assert.equal(isTextAssetPath('foo.svg'), true);
    assert.equal(isTextAssetPath('foo.png'), false);
    assert.equal(isTextAssetPath('foo.mp4'), false);
    assert.equal(isTextAssetPath('foo'), false);
});

test('kindFromRel maps brand-root-relative paths to entity kinds', () => {
    assert.equal(kindFromRel('pages/home.ef'), 'page');
    assert.equal(kindFromRel('components/header.ef'), 'component');
    assert.equal(kindFromRel('scripts/welcome.js'), 'script');
    assert.equal(kindFromRel('assets/images/logo.png'), 'asset');
    assert.equal(kindFromRel('templates/base/layout.ef'), 'templatePage');
    assert.equal(kindFromRel('variables.json'), null);
    assert.equal(kindFromRel('random.txt'), null);
});
