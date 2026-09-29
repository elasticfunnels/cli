import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConversionRow, SessionEvent } from '../src/api/types';
import { buildBuyerTable, isPiiKey, orderPageId, orderProductCodes, stripPii } from '../src/utils/orders';
import { brandHostsFrom, displayUrl, findTrackingGaps, pagePath } from '../src/utils/sessions';

// Fixture orders. Emails and names are invented (example.test is reserved).
let seq = 0;
function order(email: string | null, at: string, codes: string[], extra: Partial<ConversionRow> = {}): ConversionRow {
    seq++;
    return {
        code: `ord${seq}`,
        type: 'purchase',
        customer_email: email,
        session_id: `sess-${email ?? seq}`,
        purchased_at: at,
        product_codes_v: codes,
        total: 100,
        page_id: 10,
        ...extra,
    };
}

const BUMPS = new Set(['shi']);
const opts = { bumps: BUMPS, windowMinutes: 1440, by: 'product' as const };

test('first non-bump purchase is the package; later purchases are takes with their page', () => {
    const rows = [
        order('a@example.test', '2026-09-01T10:00:00Z', ['MAIN_6']),
        order('a@example.test', '2026-09-01T10:00:05Z', ['shi']),
        order('a@example.test', '2026-09-01T10:03:00Z', ['UP_6'], { page_id: 20 }),
        order('a@example.test', '2026-09-01T10:06:00Z', ['DOWN_3'], { page_id: 30 }),
        order('b@example.test', '2026-09-02T10:00:00Z', ['MAIN_6']),
        order('c@example.test', '2026-09-02T11:00:00Z', ['MAIN_2']),
    ];
    const t = buildBuyerTable(rows, opts);
    assert.equal(t.buyers, 3);
    assert.equal(t.took_any, 1);
    const six = t.groups.find(g => g.key === 'MAIN_6')!;
    assert.equal(six.buyers, 2);
    assert.equal(six.took_any, 1);
    assert.equal(six.take_rate, 0.5);
    assert.equal(six.bump_buyers, 1);
    assert.deepEqual(six.offers.map(o => [o.code, o.buyers, o.pages]), [['DOWN_3', 1, [30]], ['UP_6', 1, [20]]]);
    const two = t.groups.find(g => g.key === 'MAIN_2')!;
    assert.equal(two.took_any, 0);
    assert.deepEqual(two.offers, []);
});

test('buyer identity is case-insensitive email, falling back to session without email', () => {
    const rows = [
        order(' Mixed@Example.test ', '2026-09-01T10:00:00Z', ['MAIN_3']),
        order('mixed@example.test', '2026-09-01T10:02:00Z', ['UP_6']),
        order(null, '2026-09-01T12:00:00Z', ['MAIN_3'], { session_id: 'S1' }),
        order(null, '2026-09-01T12:05:00Z', ['UP_6'], { session_id: 'S1' }),
        order(null, '2026-09-01T13:00:00Z', ['MAIN_3'], { session_id: 'S2' }),
    ];
    const t = buildBuyerTable(rows, opts);
    assert.equal(t.buyers, 3);
    assert.equal(t.took_any, 2);
});

test('an order holding package + bump in one row counts the bump, not a take', () => {
    const t = buildBuyerTable([order('d@example.test', '2026-09-01T10:00:00Z', ['MAIN_3', 'shi'])], opts);
    assert.equal(t.groups[0].key, 'MAIN_3');
    assert.equal(t.groups[0].bump_buyers, 1);
    assert.equal(t.took_any, 0);
});

test('refunds, test orders, duplicate IPNs and bump-only buyers are not buyers', () => {
    const dupA = order('e@example.test', '2026-09-01T10:00:00Z', ['MAIN_3']);
    const dupB = { ...dupA, code: 'other-code' }; // same order delivered twice
    const rows = [
        dupA, dupB,
        { ...dupA }, // same code again
        order('e@example.test', '2026-09-01T10:10:00Z', ['MAIN_3'], { type: 'refund' }),
        order('f@example.test', '2026-09-01T10:00:00Z', ['MAIN_6'], { is_test: true }),
        order('g@example.test', '2026-09-01T10:00:00Z', ['shi']),
    ];
    const t = buildBuyerTable(rows, opts);
    assert.equal(t.buyers, 1);
    assert.equal(t.duplicates, 2);
    assert.equal(t.bump_only, 1);
    assert.equal(t.took_any, 0);
});

test('purchases after the window are repeat orders, and a buyer counts once per offer', () => {
    const rows = [
        order('h@example.test', '2026-09-01T10:00:00Z', ['MAIN_3']),
        order('h@example.test', '2026-09-01T10:05:00Z', ['UP_6']),
        order('h@example.test', '2026-09-01T10:07:00Z', ['UP_6']),
        order('h@example.test', '2026-09-20T10:00:00Z', ['MAIN_3']),
    ];
    const t = buildBuyerTable(rows, opts);
    assert.equal(t.later_orders, 1);
    assert.equal(t.groups[0].offers[0].buyers, 1);
});

test('--by page groups packages by the page they were bought on', () => {
    const rows = [
        order('i@example.test', '2026-09-01T10:00:00Z', ['MAIN_3'], { page_id: 312 }),
        order('j@example.test', '2026-09-01T10:00:00Z', ['MAIN_6'], { page_id: 312 }),
        order('k@example.test', '2026-09-01T10:00:00Z', ['MAIN_6'], { page_id: null, pgid: 678 }),
    ];
    const t = buildBuyerTable(rows, { ...opts, by: 'page' });
    const p312 = t.groups.find(g => g.key === '312')!;
    assert.equal(p312.buyers, 2);
    assert.deepEqual(p312.packages, ['MAIN_3', 'MAIN_6']);
    assert.ok(t.groups.find(g => g.key === '678'));
});

test('the aggregated table carries no customer data', () => {
    const t = buildBuyerTable([order('secret-person@example.test', '2026-09-01T10:00:00Z', ['MAIN_3'])], opts);
    const json = JSON.stringify(t);
    assert.ok(!json.includes('secret-person'));
    assert.ok(!json.includes('@'));
});

test('stripPii removes customer identity at every depth and keeps the order data', () => {
    const row = {
        code: 'abc', total: 99, customer_country: 'US', session_id: 's1',
        customer_email: 'x@example.test', customer_phone: '+10000000000', customer_name: 'Jane Example',
        customer_city: 'Springfield', billing_address: '1 Main St', shipping_zip: '00000', ip_address: '192.0.2.1', last4: '4242',
        transaction: [{ customer_email: 'x@example.test', amount: 99, billing_name: 'Jane Example' }],
    };
    const out = stripPii(row) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ['code', 'customer_country', 'session_id', 'total', 'transaction']);
    assert.deepEqual(out.transaction, [{ amount: 99 }]);
    // The input is untouched.
    assert.equal(row.customer_email, 'x@example.test');
    assert.ok(isPiiKey('customer_email'));
    assert.ok(!isPiiKey('customer_country'));
    assert.ok(!isPiiKey('merchant_affiliate_name'));
});

test('row accessors read legacy and standardized field names', () => {
    assert.equal(orderPageId({ pgid: 5 }), 5);
    assert.equal(orderPageId({ page_id: 0 }), null);
    assert.deepEqual(orderProductCodes({ product_codes: 'a, b' }), ['a', 'b']);
    assert.deepEqual(orderProductCodes({ products: [{ product: { code: 'z' } }] }), ['z']);
});

// ── sessions ─────────────────────────────────────────────────────────

const ev = (event: string, url: string, created_at: string): SessionEvent => ({ event, url, created_at });

test('a buy-link before any page-view is a tracking gap', () => {
    const events = [
        ev('hover', '/packages', '2026-09-01 10:00:00'),
        ev('buy-link', 'https://pay.example.test/checkout?x=1', '2026-09-01 10:00:01'),
        ev('page-view', '/upsell-1', '2026-09-01 10:01:00'),
        ev('buy-link', '/b?p=UP', '2026-09-01 10:02:00'),
    ];
    assert.deepEqual(findTrackingGaps(events), [1]);
    assert.deepEqual(findTrackingGaps(events.slice(2)), []);
});

test('displayUrl drops queries, keeps off-site hosts, and pagePath marks checkout', () => {
    const hosts = brandHostsFrom({ '1': 'https://shop.example.test', '2': 'https://www.alt.example.test' });
    assert.equal(displayUrl('/packages?aff_id=1&gclid=x'), '/packages');
    assert.equal(displayUrl('https://shop.example.test/report?v=3', { brandHosts: hosts }), '/report');
    assert.equal(displayUrl('https://alt.example.test/', { brandHosts: hosts }), '/');
    assert.equal(displayUrl('https://pay.example.test/secure/checkout.html?id=9'), 'pay.example.test/secure/checkout.html');
    assert.equal(displayUrl('/packages?aff_id=1', { full: true }), '/packages?aff_id=1');

    const path = pagePath([
        ev('page-view', '/packages?a=1', 't1'),
        ev('page-scroll', '/packages', 't2'),
        ev('buy-link', 'https://pay.example.test/checkout', 't3'),
        ev('page-view', '/upsell-1?c=2', 't4'),
        ev('page-view', '/upsell-1?c=3', 't5'),
        ev('page-view', '/last-chance', 't6'),
    ], { brandHosts: hosts });
    assert.deepEqual(path, ['/packages', 'checkout', '/upsell-1', '/last-chance']);
});
