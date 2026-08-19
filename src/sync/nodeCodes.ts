/**
 * `node_code` — the stable per-node identifier an events graph needs, and
 * that nothing server-side will give you.
 *
 * The events save endpoint reads `node_code` and never generates one
 * (`$node['data']['node_code'] ?? null`). It is minted by the visual builder
 * when a node is dragged in, and by the programmatic split-test API — neither
 * of which is involved when a graph is authored as JSON and pushed. So a
 * hand-written graph keeps exactly the codes it was given, and none where it
 * was given none.
 *
 * That failure is silent and lands far away: the graph validates, the split
 * test runs and splits traffic correctly, and only the reporting breaks —
 * analytics has no key to map a variant back to its configured name, so
 * `ef stats split <id>` shows rows like `j:null` and `` instead of "A -
 * Self-assessment" and "B - Listicle". By then the test has been live for days.
 *
 * Filling the gap on the way out is a repair, not a preference: a node without
 * a code is never the intended state.
 */

/** Node data types whose absence of a code breaks split-test reporting. */
const CODE_REQUIRED_TYPES = new Set([
    'split_test',
    'split_test_weight',
    'component_split_test',
    'page_variant',
    'dynamic_container',
    'script_rule',
]);

/**
 * Same shape the server's own builder mints: 16 chars of lowercase
 * alphanumerics. Matching the format matters because these codes are compared
 * as opaque strings across the graph, the split-test config and the analytics
 * fact — anything that round-trips is fine, but looking foreign invites a
 * "which of these is the real one" question later.
 */
export function generateNodeCode(): string {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    let out = '';
    for (let i = 0; i < 16; i++) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
}

export interface NodeCodeFill {
    /** Node ids that were given a code, in graph order. */
    filled: string[];
    /** Codes already present, so a re-push never renumbers a live test. */
    kept: number;
}

/**
 * Give every node that needs one a `node_code`, in place.
 *
 * Deliberately additive: an existing code is never rewritten. Codes are how a
 * running split test's history ties together, so regenerating one would orphan
 * the sessions already recorded against it — the reporting would go quiet
 * rather than wrong, which is worse.
 */
export function ensureNodeCodes(graph: unknown): NodeCodeFill {
    const filled: string[] = [];
    let kept = 0;

    const nodes = (graph as { drawflow?: { Home?: { data?: Record<string, unknown> } } })
        ?.drawflow?.Home?.data;
    if (!nodes || typeof nodes !== 'object') return { filled, kept };

    for (const [id, raw] of Object.entries(nodes)) {
        if (!raw || typeof raw !== 'object') continue;
        const data = (raw as { data?: Record<string, unknown> }).data;
        if (!data || typeof data !== 'object') continue;

        const type = typeof data.type === 'string' ? data.type : '';
        if (!CODE_REQUIRED_TYPES.has(type)) continue;

        const existing = data.node_code;
        if (typeof existing === 'string' && existing.trim() !== '') { kept++; continue; }

        data.node_code = generateNodeCode();
        filled.push(id);
    }
    return { filled, kept };
}

/** Exported for tests and for `ef lint`: which node types must carry a code. */
export const NODE_CODE_REQUIRED_TYPES: ReadonlySet<string> = CODE_REQUIRED_TYPES;
