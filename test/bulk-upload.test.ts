import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildBulkUploadBody, buildProductMultipartBody } from '../src/api/client';

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

test('buildProductMultipartBody sends scalar fields, JSON-encodes objects, and attaches the image', () => {
    const body = buildProductMultipartBody(BOUNDARY, {
        title: 'Herpafend 6 Bottles',
        code: 'HERPAFEND-UPS-6B',
        price: 294,
        variants: [{ code: 'v1', price: 49 }],
        skip_me: null,
        also_skip: undefined,
    }, { name: 'bottle.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }).toString('latin1');

    assert.match(body, /name="title"\r\n\r\nHerpafend 6 Bottles\r\n/);
    assert.match(body, /name="code"\r\n\r\nHERPAFEND-UPS-6B\r\n/);
    assert.match(body, /name="price"\r\n\r\n294\r\n/);
    // Arrays/objects are JSON-encoded (the controller json_decodes these).
    assert.match(body, /name="variants"\r\n\r\n\[\{"code":"v1","price":49\}\]\r\n/);
    // null / undefined fields are omitted entirely.
    assert.doesNotMatch(body, /name="skip_me"/);
    assert.doesNotMatch(body, /name="also_skip"/);
    // The image goes under the `image` field (the only field the server stores).
    assert.match(body, /name="image"; filename="bottle\.png"/);
    assert.match(body, /Content-Type: image\/png/);
    assert.ok(body.endsWith(`--${BOUNDARY}--\r\n`), 'ends with closing boundary');
});

test('buildProductMultipartBody preserves raw image bytes verbatim', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x42]);
    const body = buildProductMultipartBody(BOUNDARY, { title: 'x' }, { name: 'p.png', bytes });
    assert.ok(body.includes(bytes), 'raw image bytes survive the framing');
});
