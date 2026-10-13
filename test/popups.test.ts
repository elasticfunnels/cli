import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { splitPopupSource, popupBuilderPayload } from '../src/commands/popups';

test('splitPopupSource pulls every <style> block out, in order', () => {
    const { html, css } = splitPopupSource('<style>.a{}</style><div data-modal="true">x</div><style media="all">.b{}</style>');
    assert.equal(html, '<div data-modal="true">x</div>');
    assert.equal(css, '.a{}\n.b{}');
});

test('popupBuilderPayload sends html, css and a GrapesJS config with the same markup', () => {
    const p = popupBuilderPayload('<div data-modal="true"><button data-modal-close="true">×</button></div>\n<style>.x{}</style>');
    assert.equal(p.html, '<div data-modal="true"><button data-modal-close="true">×</button></div>');
    assert.equal(p.css, '.x{}');
    assert.deepEqual(p.interactions, []);
    const cfg = JSON.parse(p.config);
    assert.equal(cfg.pages[0].frames[0].component.components, `${p.html}\n<style>.x{}</style>`);
});

test('popupBuilderPayload accepts a bare data-modal attribute', () => {
    assert.doesNotThrow(() => popupBuilderPayload('<div data-modal>hi</div>'));
});

test('popupBuilderPayload rejects markup without data-modal, and an empty file', () => {
    assert.throws(() => popupBuilderPayload('<div class="m">hi</div>'), /data-modal="true"/);
    assert.throws(() => popupBuilderPayload('<style>.a{}</style>'), /no markup/);
});
