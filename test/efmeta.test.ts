import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EfMeta, parseEfMeta, serializeEfMeta, withEfMeta } from '../src/sync/efMeta';

const sampleMeta: EfMeta = {
    v: 1,
    type: 'page',
    brandId: 42,
    id: 100,
    slug: 'about-us',
    name: 'About us',
    revisionId: 7,
    path: 'pages/about-us.ef',
};

// What survives a write: volatile name/revisionId are intentionally dropped
// (they live in .ef-state.json), leaving a near-immutable identity line.
const stableMeta: EfMeta = {
    v: 1,
    type: 'page',
    brandId: 42,
    id: 100,
    slug: 'about-us',
    path: 'pages/about-us.ef',
};

test('serializeEfMeta drops volatile fields (name, revisionId)', () => {
    const out = serializeEfMeta(sampleMeta);
    const json = JSON.parse(out.slice('{{-- efmeta:'.length, out.length - ' --}}'.length));
    assert.equal(json.name, undefined);
    assert.equal(json.revisionId, undefined);
    assert.equal(json.id, 100);
    assert.equal(json.slug, 'about-us');
    assert.equal(json.path, 'pages/about-us.ef');
});

test('serializeEfMeta produces the {{-- efmeta:... --}} format', () => {
    const out = serializeEfMeta(sampleMeta);
    assert.ok(out.startsWith('{{-- efmeta:'), 'starts with template prefix');
    assert.ok(out.endsWith(' --}}'), 'ends with template suffix');
    // Must round-trip through JSON.parse.
    const json = out.slice('{{-- efmeta:'.length, out.length - ' --}}'.length);
    const parsed = JSON.parse(json);
    assert.equal(parsed.id, 100);
    assert.equal(parsed.brandId, 42);
});

test('parseEfMeta + withEfMeta round-trip preserves body', () => {
    const body = '<html>\n  <h1>Hello</h1>\n</html>\n';
    const file = withEfMeta(sampleMeta, body);
    const { meta, body: parsedBody } = parseEfMeta(file);
    assert.deepEqual(meta, stableMeta); // name/revisionId dropped on write
    assert.equal(parsedBody, body);
});

test('parseEfMeta strips a leading UTF-8 BOM before matching the marker', () => {
    const body = '<p>x</p>';
    const file = '\uFEFF' + withEfMeta(sampleMeta, body);
    const { meta, body: parsedBody } = parseEfMeta(file);
    assert.deepEqual(meta, stableMeta);
    assert.equal(parsedBody, body);
});

test('parseEfMeta accepts the legacy <!-- efmeta:... --> format', () => {
    const legacy = `<!-- efmeta:${JSON.stringify(sampleMeta)} -->\n<p>legacy</p>`;
    const { meta, body } = parseEfMeta(legacy);
    assert.deepEqual(meta, sampleMeta);
    assert.equal(body, '<p>legacy</p>');
});

test('parseEfMeta returns null meta on unparseable JSON without throwing', () => {
    const broken = `{{-- efmeta:{not-json --}}\n<p>x</p>`;
    const { meta, body } = parseEfMeta(broken);
    assert.equal(meta, null);
    assert.equal(body, '<p>x</p>');
});

test('parseEfMeta returns null meta when there is no efmeta line', () => {
    const { meta, body } = parseEfMeta('<p>just html</p>');
    assert.equal(meta, null);
    assert.equal(body, '<p>just html</p>');
});

test('parseEfMeta handles \\r\\n line endings', () => {
    const file = `${serializeEfMeta(sampleMeta)}\r\n<p>crlf</p>\r\n`;
    const { meta } = parseEfMeta(file);
    assert.deepEqual(meta, stableMeta);
});
