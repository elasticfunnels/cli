import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildBulkUploadBody } from '../src/api/client';

const BOUNDARY = '----TestBoundary';

test('buildBulkUploadBody indexes files and filenames in parallel', () => {
    const body = buildBulkUploadBody(BOUNDARY, 'images/logos', [
        { name: 'a.png', bytes: Buffer.from([0x89, 0x50]) },
        { name: 'b.css', bytes: Buffer.from('body{}', 'utf8') },
    ]).toString('latin1');

    assert.match(body, /name="files\[0\]"; filename="a\.png"/);
    assert.match(body, /Content-Type: image\/png/);
    assert.match(body, /name="filenames\[0\]"\r\n\r\na\.png/);

    assert.match(body, /name="files\[1\]"; filename="b\.css"/);
    assert.match(body, /Content-Type: text\/css/);
    assert.match(body, /name="filenames\[1\]"\r\n\r\nb\.css/);
});

test('buildBulkUploadBody appends the shared path field and a closing boundary', () => {
    const body = buildBulkUploadBody(BOUNDARY, 'images/logos', [
        { name: 'a.png', bytes: Buffer.from([0x01]) },
    ]).toString('latin1');

    assert.match(body, /name="path"\r\n\r\nimages\/logos\r\n/);
    assert.ok(body.endsWith(`--${BOUNDARY}--\r\n`), 'ends with closing boundary');
});

test('buildBulkUploadBody preserves raw binary bytes verbatim', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x42]);
    const body = buildBulkUploadBody(BOUNDARY, '', [{ name: 'x.bin', bytes }]);
    // The exact byte sequence must appear unmodified inside the multipart body.
    assert.ok(body.includes(bytes), 'raw bytes survive the framing');
});
