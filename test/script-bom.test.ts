import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseScriptMeta } from '../src/sync/sync';

test('parseScriptMeta parses a leading // efmeta:{...} line', () => {
    const meta = { v: 1 as const, type: 'script' as const, brandId: 1, id: 7, slug: 'hello', name: 'hello', path: 'scripts/hello.js' };
    const text = `// efmeta:${JSON.stringify(meta)}\nconsole.log('hi');\n`;
    const { meta: out, body } = parseScriptMeta(text);
    assert.deepEqual(out, meta);
    assert.equal(body, "console.log('hi');\n");
});

test('parseScriptMeta strips a leading UTF-8 BOM before matching the marker', () => {
    const meta = { v: 1 as const, type: 'script' as const, brandId: 1, id: 7, slug: 'hello' };
    const text = '\uFEFF' + `// efmeta:${JSON.stringify(meta)}\nbody();\n`;
    const { meta: out, body } = parseScriptMeta(text);
    assert.deepEqual(out, meta);
    assert.equal(body, 'body();\n');
});

test('parseScriptMeta returns null meta when first line is not a marker', () => {
    const text = `console.log('no marker');\n`;
    const { meta, body } = parseScriptMeta(text);
    assert.equal(meta, null);
    assert.equal(body, text);
});

test('parseScriptMeta does not throw on unparseable JSON', () => {
    const text = `// efmeta:{not-json}\nbody();\n`;
    const { meta, body } = parseScriptMeta(text);
    assert.equal(meta, null);
    assert.equal(body, text);
});
