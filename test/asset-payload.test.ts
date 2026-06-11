import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    needsLocalAssetFallback,
    assetEditorPayloadToBuffer,
    BINARY_EDITOR_STUB_LINE,
} from '../src/api/types';

test('needsLocalAssetFallback returns true when content_base64 decodes to the stub', () => {
    const payload = {
        id: 1,
        content_base64: Buffer.from(BINARY_EDITOR_STUB_LINE, 'utf8').toString('base64'),
    };
    assert.equal(needsLocalAssetFallback(payload), true);
});

test('needsLocalAssetFallback returns true when html is the stub line', () => {
    assert.equal(needsLocalAssetFallback({ id: 1, html: BINARY_EDITOR_STUB_LINE }), true);
});

test('needsLocalAssetFallback returns true when is_binary is true and no bytes', () => {
    assert.equal(needsLocalAssetFallback({ id: 1, is_binary: true }), true);
});

test('needsLocalAssetFallback returns false when real bytes are present', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    assert.equal(needsLocalAssetFallback({ id: 1, content_base64: png.toString('base64') }), false);
});

test('assetEditorPayloadToBuffer prefers content_base64 when present', () => {
    const bytes = Buffer.from('hello bytes', 'utf8');
    const payload = { id: 1, content_base64: bytes.toString('base64'), html: 'ignored' };
    assert.deepEqual(assetEditorPayloadToBuffer(payload), bytes);
});

test('assetEditorPayloadToBuffer falls back to html bytes when no base64', () => {
    const payload = { id: 1, html: 'plain text content' };
    assert.deepEqual(assetEditorPayloadToBuffer(payload), Buffer.from('plain text content', 'utf8'));
});
