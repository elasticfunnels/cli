import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ensureNodeCodes, generateNodeCode, NODE_CODE_PATTERN } from '../src/sync/nodeCodes';

/**
 * `node_code` on a hand-authored events graph.
 *
 * Seen for real: an agent authored a correct 50/50 split test with both
 * variants named, pushed it, and the traffic split worked. Days later the
 * report showed arms called `j:null` and `` — the runtime had handed a null
 * code to express `res.cookie()`, which serialises it as that literal string,
 * so BOTH arms recorded the same value and the test measured no split at all.
 *
 * The server now mints missing codes on every page-events write. This fill is
 * the compatibility half: the CLI ships independently of the server it talks
 * to, and both sides only ever fill a gap, so running both is safe.
 */

function graph(nodes: Record<string, { type: string; node_code?: string }>): unknown {
    return {
        drawflow: {
            Home: {
                data: Object.fromEntries(
                    Object.entries(nodes).map(([id, data]) => [id, { id: Number(id), data: { ...data } }]),
                ),
            },
        },
    };
}

function codes(g: unknown): Record<string, string | undefined> {
    const data = (g as { drawflow: { Home: { data: Record<string, { data: { node_code?: string } }> } } })
        .drawflow.Home.data;
    return Object.fromEntries(Object.entries(data).map(([id, n]) => [id, n.data.node_code]));
}

test('every typed node gets a code, matching what the server mints', () => {
    // Including `entry`: funnel step URLs are built from node_code
    // (/f/<funnel_code>/<node_code>), so narrowing this to the split-test chain
    // would leave the CLI and the server disagreeing about what a normalised
    // graph looks like — which surfaces later as phantom drift in `ef diff`.
    const g = graph({
        1: { type: 'entry' },
        2: { type: 'split_test' },
        3: { type: 'split_test_weight' },
        4: { type: 'split_test_weight' },
        5: { type: 'page_variant' },
    });
    const r = ensureNodeCodes(g);
    assert.deepEqual(r.filled, ['1', '2', '3', '4', '5']);

    const c = codes(g);
    for (const id of ['1', '2', '3', '4', '5']) {
        assert.match(c[id]!, NODE_CODE_PATTERN, `node ${id} got a server-shaped code`);
    }
    assert.equal(new Set(Object.values(c)).size, 5, 'codes are distinct');
});

test('a node with no type is left alone for the validator to report', () => {
    const g = graph({ 1: { type: '' } });
    assert.deepEqual(ensureNodeCodes(g).filled, []);
});

test('an existing code is never rewritten', () => {
    // Codes tie a running test's recorded sessions together. Regenerating one
    // orphans that history — the reporting goes quiet rather than wrong, which
    // is the harder failure to notice.
    const g = graph({
        2: { type: 'split_test', node_code: 'keepthiscode00xy' },
        3: { type: 'split_test_weight' },
    });
    const r = ensureNodeCodes(g);
    assert.deepEqual(r.filled, ['3']);
    assert.equal(r.kept, 1);
    assert.equal(codes(g)['2'], 'keepthiscode00xy');
});

test('filling is idempotent, so re-pushing a live test does not renumber it', () => {
    const g = graph({ 2: { type: 'split_test' }, 3: { type: 'split_test_weight' } });
    ensureNodeCodes(g);
    const first = codes(g);
    const second = ensureNodeCodes(g);
    assert.deepEqual(second.filled, []);
    assert.equal(second.kept, 2);
    assert.deepEqual(codes(g), first);
});

test('a blank or whitespace code counts as missing', () => {
    const g = graph({ 2: { type: 'split_test', node_code: '' }, 3: { type: 'split_test_weight', node_code: '   ' } });
    assert.deepEqual(ensureNodeCodes(g).filled, ['2', '3']);
});

test('a graph with no nodes, or a malformed one, is handled rather than thrown on', () => {
    assert.deepEqual(ensureNodeCodes({ drawflow: { Home: { data: {} } } }).filled, []);
    assert.deepEqual(ensureNodeCodes({}).filled, []);
    assert.deepEqual(ensureNodeCodes(null).filled, []);
    assert.deepEqual(ensureNodeCodes({ drawflow: { Home: { data: { 1: null } } } }).filled, []);
});

test('generateNodeCode matches the shape the server\'s own builder mints', () => {
    for (let i = 0; i < 50; i++) assert.match(generateNodeCode(), NODE_CODE_PATTERN);
    assert.equal(new Set(Array.from({ length: 200 }, generateNodeCode)).size, 200, 'no collisions in 200');
});

test('the whole split-test chain comes back coded', () => {
    const g = graph({
        1: { type: 'split_test' },
        2: { type: 'split_test_weight' },
        3: { type: 'page_variant' },
        4: { type: 'component_split_test' },
    });
    ensureNodeCodes(g);
    for (const [id, code] of Object.entries(codes(g))) {
        assert.match(code!, NODE_CODE_PATTERN, `node ${id} must carry a code`);
    }
});
