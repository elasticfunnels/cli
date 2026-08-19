import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ensureNodeCodes, generateNodeCode, NODE_CODE_REQUIRED_TYPES } from '../src/sync/nodeCodes';

/**
 * `node_code` on a hand-authored events graph.
 *
 * Seen for real: an agent authored a correct 50/50 split test with both
 * variants named, pushed it, and the traffic split worked. Days later
 * `ef stats split 503` reported the arms as `j:null` and `` — analytics had no
 * key to map a variant back to its configured name. The save endpoint reads
 * `node_code` and never mints one, and neither the visual builder nor the
 * programmatic split-test API was involved, so the graph simply never had any.
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

test('every node that split-test reporting keys on gets a code', () => {
    const g = graph({
        1: { type: 'entry' },
        2: { type: 'split_test' },
        3: { type: 'split_test_weight' },
        4: { type: 'split_test_weight' },
        5: { type: 'page_variant' },
    });
    const r = ensureNodeCodes(g);
    assert.deepEqual(r.filled, ['2', '3', '4', '5']);

    const c = codes(g);
    assert.equal(c['1'], undefined, 'entry needs no code and must not be given noise');
    for (const id of ['2', '3', '4', '5']) {
        assert.match(c[id]!, /^[0-9a-z]{16}$/, `node ${id} got a server-shaped code`);
    }
    assert.equal(new Set(Object.values(c).filter(Boolean)).size, 4, 'codes are distinct');
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
    for (let i = 0; i < 50; i++) assert.match(generateNodeCode(), /^[0-9a-z]{16}$/);
    assert.equal(new Set(Array.from({ length: 200 }, generateNodeCode)).size, 200, 'no collisions in 200');
});

test('the required-type set covers the split-test chain end to end', () => {
    for (const t of ['split_test', 'split_test_weight', 'page_variant', 'component_split_test']) {
        assert.ok(NODE_CODE_REQUIRED_TYPES.has(t), `${t} must carry a code`);
    }
});
