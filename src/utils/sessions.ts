import { SessionEvent } from '../models/order';

/**
 * Pure helpers behind `ef sessions`. No I/O, so the tests can drive them.
 */

/**
 * Events that fire dozens of times per page and bury the path a visitor took.
 * Hidden from the human timeline by default (`--all-events` shows them); the
 * JSON output is always complete.
 */
export const NOISY_EVENTS = new Set(['hover', 'page-scroll', 'video-time', 'tab-switched', 'tab-switched-back']);

/**
 * Display form of a tracked URL.
 *
 * Same-site URLs (a path, or a host in `brandHosts`) print as the path; an
 * off-site URL (a payment processor's checkout) keeps its host, because
 * "left for the checkout host" is the point of that row. The query string is
 * dropped unless `full` — it carries click ids and tracking params that make
 * every line unreadable and add nothing to the path.
 */
export function displayUrl(raw: string | null | undefined, opts: { full?: boolean; brandHosts?: Set<string> } = {}): string {
    if (!raw) return '';
    const s = String(raw);
    if (opts.full) return s;
    let u: URL;
    try {
        u = new URL(s, 'http://_relative_');
    } catch {
        return s.split('?')[0];
    }
    const relative = u.host === '_relative_';
    const host = u.host.replace(/^www\./, '');
    if (relative || (opts.brandHosts && opts.brandHosts.has(host))) return u.pathname || '/';
    return `${host}${u.pathname === '/' ? '' : u.pathname}`;
}

/** Hosts of the brand's own domains, from the session payload's `domains` map. */
export function brandHostsFrom(domains: Record<string, string> | undefined): Set<string> {
    const hosts = new Set<string>();
    for (const url of Object.values(domains ?? {})) {
        try { hosts.add(new URL(url).host.replace(/^www\./, '')); } catch { /* skip */ }
    }
    return hosts;
}

/**
 * `buy-link` events with no `page-view` anywhere earlier in the session.
 *
 * A buy click needs a page to be clicked on, so one with no page load before
 * it means the page-view was never recorded — a tracking gap (a page without
 * the tracking script, a cached page, a view that fired after the click).
 * Conversion rates computed from page views undercount that page.
 * Returns indexes into `events`, which must already be in time order.
 */
export function findTrackingGaps(events: SessionEvent[]): number[] {
    const gaps: number[] = [];
    let seenView = false;
    events.forEach((e, i) => {
        if (e.event === 'page-view') seenView = true;
        else if (e.event === 'buy-link' && !seenView) gaps.push(i);
    });
    return gaps;
}

/** Events sorted by `created_at` (the server already does; this makes it a guarantee). */
export function sortEvents(events: SessionEvent[]): SessionEvent[] {
    return [...events].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

/**
 * The path a visitor took: each page-view, plus "checkout" where a buy-link
 * sent them off-site to pay. Consecutive duplicates collapsed.
 */
export function pagePath(events: SessionEvent[], opts: { brandHosts?: Set<string> } = {}): string[] {
    const out: string[] = [];
    for (const e of events) {
        let step: string | null = null;
        if (e.event === 'page-view') {
            step = displayUrl(e.url, { brandHosts: opts.brandHosts });
        } else if (e.event === 'buy-link') {
            const shown = displayUrl(e.url, { brandHosts: opts.brandHosts });
            step = shown.startsWith('/') ? `buy ${shown}` : 'checkout';
        }
        if (step != null && out[out.length - 1] !== step) out.push(step);
    }
    return out;
}

/** First non-null value of `key` across events (the visit summary lacks aff_id). */
export function firstEventValue(events: SessionEvent[], ...keys: string[]): unknown {
    for (const e of events) {
        for (const k of keys) {
            const v = e[k];
            if (v != null && v !== '') return v;
        }
    }
    return null;
}
