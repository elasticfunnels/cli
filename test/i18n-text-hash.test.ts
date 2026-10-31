import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { decodeEntities, translationSourceHash, visibleText } from '../src/utils/textHash';

interface Vector { name: string; seo_title: string | null; seo_description: string | null; html: string | null; visible_text: string; hash: string }

const FIXTURE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'i18n-text-hash-vectors.json');
const { vectors } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { vectors: Vector[] };

test('hash vectors: the fixture has rows', () => {
    assert.ok(vectors.length >= 10);
});

for (const v of vectors) {
    test(`hash vector "${v.name}" matches the PHP reference`, () => {
        assert.equal(visibleText(v.html), v.visible_text);
        assert.equal(translationSourceHash(v), v.hash);
    });
}

test('decodeEntities: named need ";", case-sensitive, single pass', () => {
    assert.equal(decodeEntities('&amp;lt; &amp &AMP; &Amp;'), '&lt; &amp & &Amp;');
});

test('decodeEntities: refused numeric code points stay as written', () => {
    assert.equal(decodeEntities('&#0;&#11;&#127;&#xFDD0;&#x1FFFF;&#x110000;'), '&#0;&#11;&#127;&#xFDD0;&#x1FFFF;&#x110000;');
    assert.equal(decodeEntities('&#9;&#10;&#12;&#x1F600;'), '\t\n\f\u{1F600}');
});

test('visibleText: a quoted ">" inside an attribute does not end the tag', () => {
    assert.equal(visibleText('<a title="x > y" href=\'/a>b\'>Go</a>'), 'Go');
});

test('translationSourceHash: null and "" are the same input', () => {
    assert.equal(
        translationSourceHash({ seo_title: null, seo_description: undefined, html: null }),
        translationSourceHash({ seo_title: '', seo_description: '', html: '' }),
    );
});
