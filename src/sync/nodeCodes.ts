/**
 * `node_code` — the graph's durable identity, filled in before a push.
 *
 * It is not cosmetic. The runtime writes the chosen split-test arm's code into
 * the `st_res_<id>` cookie, analytics groups variants by it, `winner_node_code`
 * points at it, and funnel step URLs are built from it
 * (`/f/<funnel_code>/<node_code>`).
 *
 * It was historically minted only in the browser — the canvas generates one on
 * drawflow's `nodeCreated` — so a graph written through the API never had any,
 * and the runtime handed a null to express `res.cookie()`, which serialises it
 * as the literal string `j:null`. Both arms then wrote the same value, so the
 * test recorded no split at all while appearing to run correctly.
 *
 * The server now mints missing codes on every page-events write, so this is a
 * COMPATIBILITY FALLBACK rather than the primary mechanism: the CLI ships
 * independently of the server it talks to, and a brand on an older release
 * still needs its graphs to carry codes.
 *
 * It is safe to run against a current server. Both sides only ever FILL a
 * missing code and neither rewrites an existing one, so a code supplied here is
 * preserved verbatim, and one supplied by neither is minted server-side.
 */

/**
 * Every node gets a code, matching what the server mints.
 *
 * Not just the split-test chain: `entry` needs one too, because funnel step
 * URLs are built from it. Narrowing this to the nodes whose absence visibly
 * breaks reporting would leave the CLI and the server disagreeing about what a
 * normalised graph looks like, which shows up later as phantom drift in
 * `ef diff`.
 */
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
 * Give every node lacking one a `node_code`, in place.
 *
 * Deliberately additive, and the server makes the same bargain: an existing
 * code is never rewritten. Codes are how a running split test's history ties
 * together, so regenerating one would orphan the sessions already recorded
 * against it — the reporting would go quiet rather than wrong, which is worse.
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

        // A node with no type is malformed; the validator reports that, and
        // stamping an identity onto it would only make the report confusing.
        const type = typeof data.type === 'string' ? data.type : '';
        if (type === '') continue;

        const existing = data.node_code;
        if (typeof existing === 'string' && existing.trim() !== '') { kept++; continue; }

        data.node_code = generateNodeCode();
        filled.push(id);
    }
    return { filled, kept };
}

/**
 * Same shape the server mints. Kept in sync deliberately: two generators that
 * disagree on format turn "which of these is the real code" into a question
 * someone has to answer at the worst possible moment.
 */
export const NODE_CODE_PATTERN = /^[0-9a-z]{16}$/;
