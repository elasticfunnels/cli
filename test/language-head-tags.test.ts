import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ownLanguageHeadTags, languageHeadTagsWarning } from '../src/utils/languageHeadTags';
import { lintEfContent } from '../src/lint/lintEf';

const own = '<head><link rel="canonical" href="https://x.com/es/a"><link rel="alternate" hreflang="en" href="https://x.com/a"><meta property="og:locale" content="es_ES"></head><p>hola</p>';

test('finds hand-written hreflang, canonical and og:locale', () => {
    assert.deepEqual(ownLanguageHeadTags(own), ['hreflang', 'canonical', 'og:locale']);
    assert.deepEqual(ownLanguageHeadTags('<link rel="stylesheet" href="a.css"><p>x</p>'), []);
    assert.deepEqual(ownLanguageHeadTags('<meta property="og:locale:alternate" content="en_US">'), ['og:locale']);
});

test('ignores backend comments and backend scripts', () => {
    assert.deepEqual(ownLanguageHeadTags('{{-- <link rel="canonical" href="/x"> --}}<script scope="backend">const s = \'<link hreflang="en">\';</script>'), []);
});

test('warns only for a page with a language', () => {
    assert.equal(languageHeadTagsWarning(null, own), null);
    assert.equal(languageHeadTagsWarning('es', '<p>x</p>'), null);
    assert.match(languageHeadTagsWarning('es', own) ?? '', /own hreflang, canonical, og:locale tags/);
});

test('ef lint warns on a language page with its own tags, never errors', () => {
    const meta = '{{-- efmeta:{"v":1,"type":"page","brandId":1,"id":2,"slug":"es/a","path":"pages/es/a.ef","language":"es"} --}}\n';
    const r = lintEfContent(meta + own, { filePath: 'pages/es/a.ef' });
    assert.equal(r.ok, true);
    assert.ok(r.issues.some((i) => i.severity === 'warning' && /language es/.test(i.message)));
    const plain = lintEfContent(meta.replace(',"language":"es"', '') + own, { filePath: 'pages/a.ef' });
    assert.ok(!plain.issues.some((i) => /language/.test(i.message)));
});
