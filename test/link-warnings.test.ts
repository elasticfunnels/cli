import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatLinkWarnings, linkErrorSummary, linkWarningBlock, linkWarningMessage, linkWarningReports } from '../src/sync/linkWarnings';

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

test('pasted link whose sales never reach ElasticFunnels is an error with its own message', () => {
    const msg = linkWarningMessage({ level: 'error', type: 'pasted_link_lost_sales', gateway: 'clickbank', count: 1 });
    assert.match(msg, /^ClickBank buy link pasted into the page skips the ElasticFunnels purchase step/);
    assert.match(msg, /no ClickBank sale notice/);
    assert.match(msg, /\[BUY=CODE\]/);
    assert.doesNotMatch(msg, /—/);
    assert.doesNotMatch(linkWarningMessage({ level: 'error', type: 'pasted_link_lost_sales' }), /no {2}sale/);
});

test('an unknown error type still says sales are at stake', () => {
    assert.match(linkWarningMessage({ level: 'error', type: 'brand_new_kind', gateway: 'jvzoo' }), /^Link error \(brand_new_kind, JVZoo\): sales/);
    assert.equal(linkWarningMessage({ level: 'hint', type: 'brand_new_kind' }), 'Link warning: brand_new_kind');
});

test('printed block puts errors under a LINK ERRORS heading, then hints', () => {
    const out = linkWarningBlock([
        { level: 'hint', type: 'pasted_link', gateway: 'buygoods' },
        { level: 'error', type: 'unmapped_product', code: 'X1' },
    ], 'pages/a.ef');
    assert.deepEqual(out.map((o) => o.level), ['error', 'detail', 'hint', 'detail']);
    assert.match(out[0].line, /^LINK ERRORS in pages\/a\.ef: sales or upsells are lost/);
    assert.match(out[1].line, /Product code X1/);
    assert.equal(out[2].line, 'Link hints for pages/a.ef:');
    assert.deepEqual(linkWarningBlock(undefined, 'pages/a.ef'), []);
});

test('json reports keep the server fields, add the message, errors first', () => {
    const r = linkWarningReports([
        { level: 'hint', type: 'pasted_link', gateway: 'buygoods', count: 2 },
        { level: 'error', type: 'other_account', gateway: 'clickbank', account: 'acme' },
    ]);
    assert.equal(r[0].level, 'error');
    assert.equal(r[0].account, 'acme');
    assert.match(r[0].message, /account acme/);
    assert.equal(r[1].count, 2);
    assert.equal('code' in r[1], false);
});

test('summary speaks to agents only when there is an error', () => {
    assert.deepEqual(linkErrorSummary(0, 0), []);
    const lines = linkErrorSummary(2, 1);
    assert.match(lines[0], /^2 link errors on 1 file/);
    assert.match(lines[1], /AI agents: stop here and tell the user/);
});
