import { createHash } from 'crypto';
import { ConversionRow } from '../models/order';

/**
 * Pure helpers behind `ef orders`: PII stripping and the per-buyer take table.
 * Kept free of I/O so the tests can drive them with fixture rows.
 */

// ── PII ─────────────────────────────────────────────────────────────

/**
 * Keys that identify or locate a customer. Removed at every depth (the
 * `transaction` relation repeats several of them) unless `--include-pii`.
 *
 * `customer_country` is deliberately kept: it is a reporting dimension, not
 * something that identifies a person, and the dashboard groups by it.
 */
const PII_KEY = /^(customer_(email|phone|phone_e164|name|first_name|last_name|city|state|zip|address.*)|billing_.*|shipping_.*|ip_address6?|last4|card_last4|tracking_number|email|phone|first_name|last_name|full_name|address.*|zip|postal_code)$/i;
const PII_KEEP = new Set(['customer_country']);

export function isPiiKey(key: string): boolean {
    return !PII_KEEP.has(key) && PII_KEY.test(key);
}

/** Deep copy of `value` with every PII key removed. Never mutates the input. */
export function stripPii<T>(value: T): T {
    if (Array.isArray(value)) return value.map(v => stripPii(v)) as unknown as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (isPiiKey(k)) continue;
            out[k] = stripPii(v);
        }
        return out as T;
    }
    return value;
}

// ── Row accessors (the ES docs carry legacy and standardized names) ──

export function orderPageId(row: ConversionRow): number | null {
    const v = row.page_id ?? row.pgid ?? row.page?.id ?? null;
    return v == null || v === 0 ? null : Number(v);
}

export function orderFunnelId(row: ConversionRow): number | null {
    const v = row.funnel_id ?? row.fid ?? row.funnel?.id ?? null;
    return v == null || v === 0 ? null : Number(v);
}

export function orderProductCodes(row: ConversionRow): string[] {
    if (Array.isArray(row.product_codes_v) && row.product_codes_v.length) return row.product_codes_v.map(String);
    if (Array.isArray(row.product_codes) && row.product_codes.length) return row.product_codes.map(String);
    if (typeof row.product_codes === 'string' && row.product_codes.trim()) {
        return row.product_codes.split(',').map(s => s.trim()).filter(Boolean);
    }
    return (row.products ?? []).map(p => p.product?.code).filter((c): c is string => !!c);
}

export function orderTotal(row: ConversionRow): number {
    const n = Number(row.total ?? 0);
    return Number.isFinite(n) ? n : 0;
}

export function orderTime(row: ConversionRow): number {
    const t = Date.parse(String(row.purchased_at ?? row.created_at ?? ''));
    return Number.isFinite(t) ? t : 0;
}

/**
 * Stable, non-reversible buyer identity: a hash of the normalised email, or
 * the session when the order has no email, or the order itself. The hash
 * never leaves this module — it only groups.
 */
export function buyerKey(row: ConversionRow): string {
    const email = typeof row.customer_email === 'string' ? row.customer_email.trim().toLowerCase() : '';
    if (email) return 'e:' + createHash('sha256').update(email).digest('hex');
    if (row.session_id) return 's:' + row.session_id;
    return 'o:' + (row.code ?? String(row.purchased_at ?? row.created_at ?? ''));
}

// ── Buyer take table ────────────────────────────────────────────────

export interface BuyerTableOptions {
    /** Order-bump product codes: attach to the package, never count as a take. */
    bumps: Set<string>;
    /** A purchase more than this many minutes after the package is a repeat order, not a take. */
    windowMinutes: number;
    /** Group packages by the front-end product (default) or by the page it was bought on. */
    by: 'product' | 'page';
}

export interface OfferTake {
    code: string;
    /** Buyers in the group who bought this offer at least once. */
    buyers: number;
    /** Page ids the offer was bought on, most frequent first. */
    pages: number[];
}

export interface BuyerGroup {
    /** Product code (by product) or page id as a string (by page); "(none)" when unknown. */
    key: string;
    /** Front-end product codes seen in the group (one when grouped by product). */
    packages: string[];
    buyers: number;
    took_any: number;
    take_rate: number;
    bump_buyers: number;
    median_paid: number | null;
    offers: OfferTake[];
}

export interface BuyerTable {
    buyers: number;
    took_any: number;
    /** Buyers whose only purchases were bumps (no package in range). */
    bump_only: number;
    /** Purchases after the take window, per buyer: repeat orders, not takes. */
    later_orders: number;
    /** Orders dropped as exact duplicates (same buyer, products and second). */
    duplicates: number;
    groups: BuyerGroup[];
}

interface Purchase { t: number; codes: string[]; page: number | null; total: number }

/**
 * Group purchases by buyer and classify each one as package, bump or take.
 *
 *   package  the buyer's first purchase (in time order) that holds a non-bump
 *            product; its first non-bump code is the front-end product
 *   bump     a bump code, in the package order or in its own order
 *   take     any later non-bump product bought within `windowMinutes` of the
 *            package — an upsell or downsell taken
 *
 * Only `type === 'purchase'` rows count; refunds and test orders are ignored.
 * A buyer is counted once per offer however many times they bought it.
 */
export function buildBuyerTable(rows: ConversionRow[], opts: BuyerTableOptions): BuyerTable {
    const seenCodes = new Set<string>();
    const seenShapes = new Set<string>();
    let duplicates = 0;
    const byBuyer = new Map<string, Purchase[]>();

    for (const row of rows) {
        if (row.type !== 'purchase' || row.is_test) continue;
        if (row.code) {
            if (seenCodes.has(row.code)) { duplicates++; continue; }
            seenCodes.add(row.code);
        }
        const key = buyerKey(row);
        const codes = orderProductCodes(row);
        const t = orderTime(row);
        // The same order delivered twice (two IPNs) arrives under two codes
        // with identical content to the second. Collapse those.
        const shape = `${key}|${[...codes].sort().join('+')}|${Math.floor(t / 1000)}`;
        if (seenShapes.has(shape)) { duplicates++; continue; }
        seenShapes.add(shape);
        const list = byBuyer.get(key) ?? [];
        list.push({ t, codes, page: orderPageId(row), total: orderTotal(row) });
        byBuyer.set(key, list);
    }

    interface Acc { packages: Set<string>; buyers: number; tookAny: number; bump: number; paid: number[]; offers: Map<string, { buyers: number; pages: Map<number, number> }> }
    const groups = new Map<string, Acc>();
    let bumpOnly = 0;
    let laterOrders = 0;
    const windowMs = opts.windowMinutes * 60_000;

    for (const purchases of byBuyer.values()) {
        purchases.sort((a, b) => a.t - b.t);
        const pkgIdx = purchases.findIndex(p => p.codes.some(c => !opts.bumps.has(c)));
        if (pkgIdx < 0) { bumpOnly++; continue; }
        const pkg = purchases[pkgIdx];
        const mainCode = pkg.codes.find(c => !opts.bumps.has(c))!;
        let hasBump = pkg.codes.some(c => opts.bumps.has(c));
        const taken = new Map<string, number | null>();

        for (let i = pkgIdx + 1; i < purchases.length; i++) {
            const p = purchases[i];
            if (p.t - pkg.t > windowMs) { laterOrders++; continue; }
            for (const code of p.codes) {
                if (opts.bumps.has(code)) { hasBump = true; continue; }
                if (!taken.has(code)) taken.set(code, p.page);
            }
        }
        // A bump bought in its own order a moment BEFORE the package row landed
        // (IPN ordering) still belongs to it.
        for (let i = 0; i < pkgIdx; i++) {
            if (purchases[i].codes.some(c => opts.bumps.has(c)) && pkg.t - purchases[i].t <= windowMs) hasBump = true;
        }

        const gKey = opts.by === 'page' ? (pkg.page != null ? String(pkg.page) : '(none)') : mainCode;
        const acc: Acc = groups.get(gKey) ?? { packages: new Set<string>(), buyers: 0, tookAny: 0, bump: 0, paid: [], offers: new Map() };
        acc.packages.add(mainCode);
        acc.buyers++;
        if (taken.size > 0) acc.tookAny++;
        if (hasBump) acc.bump++;
        acc.paid.push(pkg.total);
        for (const [code, page] of taken) {
            const o = acc.offers.get(code) ?? { buyers: 0, pages: new Map<number, number>() };
            o.buyers++;
            if (page != null) o.pages.set(page, (o.pages.get(page) ?? 0) + 1);
            acc.offers.set(code, o);
        }
        groups.set(gKey, acc);
    }

    const out: BuyerGroup[] = [...groups.entries()].map(([key, a]) => ({
        key,
        packages: [...a.packages].sort(),
        buyers: a.buyers,
        took_any: a.tookAny,
        take_rate: a.buyers ? round4(a.tookAny / a.buyers) : 0,
        bump_buyers: a.bump,
        median_paid: median(a.paid),
        offers: [...a.offers.entries()]
            .map(([code, o]) => ({ code, buyers: o.buyers, pages: [...o.pages.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => p) }))
            .sort((x, y) => y.buyers - x.buyers || x.code.localeCompare(y.code)),
    })).sort((x, y) => y.buyers - x.buyers || x.key.localeCompare(y.key));

    return {
        buyers: out.reduce((n, g) => n + g.buyers, 0),
        took_any: out.reduce((n, g) => n + g.took_any, 0),
        bump_only: bumpOnly,
        later_orders: laterOrders,
        duplicates,
        groups: out,
    };
}

function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
