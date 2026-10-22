import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatLinkWarnings, linkWarningMessage } from '../src/sync/linkWarnings';

test('no warnings prints nothing', () => {
    assert.deepEqual(formatLinkWarnings(undefined, 'pages/a.html'), []);
    assert.deepEqual(formatLinkWarnings([], 'pages/a.html'), []);
});

test('errors come before hints and carry the file name', () => {
    const out = formatLinkWarnings([
        { level: 'hint', type: 'pasted_link', gateway: 'buygoods', count: 1 },
        { level: 'error', type: 'other_account', gateway: 'clickbank', account: 'glucotrust', count: 2 },
        { level: 'error', type: 'unmapped_product', code: 'GLP2V1' },
    ], 'pages/a.html');
    assert.deepEqual(out.map((o) => o.level), ['error', 'error', 'hint']);
    assert.match(out[0].line, /^pages\/a\.html: ClickBank buy link goes to account glucotrust/);
    assert.match(out[1].line, /Product code GLP2V1 matches no product/);
    assert.match(out[2].line, /BuyGoods buy link pasted into the page\. Use a \[BUY=CODE\] tag/);
});

test('other account with no account read means the brand has no merchant on that gateway', () => {
    assert.match(linkWarningMessage({ level: 'error', type: 'other_account', gateway: 'digistore24', account: null }), /has no Digistore24 merchant/);
    assert.match(linkWarningMessage({ level: 'error', type: 'tracking_off', gateway: 'jvzoo' }), /tracking for pasted links is off on the JVZoo merchant/);
});
