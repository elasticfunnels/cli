/**
 * `ef funnels which <url>`: the funnels list's "Which funnel runs?" tester.
 *
 * The app (FunnelTriggerController@resolveTest) sends a real request to the URL with a
 * resolve-and-report header, so the page runtime resolves it exactly as it would a live
 * visitor. Affiliate, query parameters, host and path are read from the URL; only country
 * and region are passed, because they come from the visitor's IP. Read only.
 */
import { FunnelResolveDestination, FunnelResolveResult, FunnelResolveTraceRow } from '../api/types';
import { CliError, ExitCode, ExitCodeValue } from '../utils/exit';
import { c } from '../utils/log';
import { safeText } from '../utils/sanitize';

/** Validate the URL and fold `--param key=value` pairs into its query string. */
export function buildWhichUrl(raw: string, params: string[] = []): string {
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        throw new CliError(ExitCode.Validation, `"${raw}" is not a valid URL. Pass a full http(s) URL, e.g. https://shop.example.com/offer?aff=123`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new CliError(ExitCode.Validation, `Only http and https URLs can be tested (got ${u.protocol}).`);
    }
    for (const p of params) {
        const eq = p.indexOf('=');
        if (eq <= 0) throw new CliError(ExitCode.Validation, `--param expects key=value (got "${p}").`);
        u.searchParams.append(p.slice(0, eq), p.slice(eq + 1));
    }
    return u.toString();
}

export function normaliseCountry(v: string | undefined): string | null {
    if (v == null || v.trim() === '') return null;
    const s = v.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(s)) throw new CliError(ExitCode.Validation, `--country expects a two-letter country code such as US or GB (got "${v}").`);
    return s;
}

export function normaliseRegion(v: string | undefined): string | null {
    if (v == null || v.trim() === '') return null;
    const s = v.trim();
    if (s.length > 64) throw new CliError(ExitCode.Validation, '--region is at most 64 characters.');
    return s;
}

const WON_VIA: Record<string, string> = {
    trigger_override_won: 'It won on a trigger override.',
    domain_default_won: 'It is the default funnel for this domain.',
    unfiltered_default_fallback: 'It is the domain default, used as the final fallback.',
};

const ELIMINATED: Array<[string, string]> = [
    ['entry_pages', 'This page is not one of their entry pages'],
    ['no_overrides', 'No overrides, so they can only run as the domain default'],
    ['is_default', 'Already the domain default, so their overrides are never read'],
    ['not_matched', 'Their overrides did not match this visitor'],
];

function eliminationReason(row: FunnelResolveTraceRow): string | null {
    if (row.step === 'entry_pages' && row.outcome === 'excluded') return 'entry_pages';
    if (row.step !== 'trigger_overrides') return null;
    if (row.outcome === 'not_matched') return 'not_matched';
    if (row.outcome !== 'skipped') return null;
    return row.reason === 'is_domain_default_overrides_never_evaluated' ? 'is_default' : 'no_overrides';
}

function funnelName(r: FunnelResolveResult, id: number | null | undefined, code: string | null | undefined): string {
    const title = id != null ? r.funnel_titles?.[String(id)] : undefined;
    if (title) return code ? `${safeText(title)} ${c.dim(`(${safeText(code)})`)}` : safeText(title);
    return code ? safeText(code) : `#${id ?? '?'}`;
}

function destination(to: FunnelResolveDestination | null | undefined): string {
    if (!to || to.kind === 'fallback' || to.kind === 'none') return c.yellow('no next step, so the buyer gets the merchant\'s or the default thank-you page');
    if (to.kind === 'split') return `a split test with ${to.arms ?? 0} arms`;
    if (to.kind === 'branches') return `a condition with ${to.arms ?? 0} outcomes`;
    if (to.kind === 'switch_funnel') return 'another funnel';
    if (to.kind === 'url') return safeText(to.url ?? '');
    const slug = to.slug != null ? `/${safeText(to.slug)}` : `#${to.page_id ?? '?'}`;
    const draft = to.status && to.status !== 'published' ? c.yellow(' (draft)') : '';
    return to.title ? `${safeText(to.title)}, ${slug}${draft}` : `${slug}${draft}`;
}

/** The decisive override's conditions, one fact per line: affiliate lists collapse to a count. */
function conditionLines(r: FunnelResolveResult, row: FunnelResolveTraceRow): string[] {
    const leaves = (row.conditions ?? []).filter((x) => x && x.field);
    const out: string[] = [];
    const aff = leaves.filter((x) => x.field === 'affiliate');
    const visitorAff = r.context?.affiliate;
    if (aff.length && visitorAff != null && visitorAff !== '') {
        out.push(aff.length === 1
            ? `Affiliate ${safeText(visitorAff)} matched the only affiliate ID in this override.`
            : `Affiliate ${safeText(visitorAff)} is one of the ${aff.length} affiliate IDs in this override.`);
    }
    const other = leaves.filter((x) => x.field !== 'affiliate')
        .map((x) => `${safeText(x.field)} ${safeText(x.operator)} "${safeText(x.value)}"`);
    if (other.length) out.push(`Conditions: ${other.join(', ')}`);
    const nested = (row.conditions ?? []).filter((x) => x && !x.field && x.group).length;
    if (nested) out.push(`Plus nested condition groups (${nested}).`);
    return out;
}

/** Human report for a resolved result. Every server string goes through safeText. */
export function renderWhich(r: FunnelResolveResult, opts: { listLimit?: number } = {}): string[] {
    const limit = opts.listLimit ?? 8;
    const lines: string[] = [];
    if (r.winner) {
        const title = r.winner.title ? c.bold(safeText(r.winner.title)) : c.bold(safeText(r.winner.code ?? `#${r.winner.id}`));
        const code = r.winner.code ? ` ${c.dim(`code ${safeText(r.winner.code)}`)}` : '';
        lines.push(`${c.green('✓')} This URL runs ${title}${code}${r.winner.id != null ? c.dim(` #${r.winner.id}`) : ''}`);
        const via = r.won_via ? (WON_VIA[r.won_via] ?? `Won via ${safeText(r.won_via)}.`) : '';
        if (via) lines.push(`  ${via}`);
    } else {
        lines.push(`${c.yellow('!')} No funnel would run for this URL.`);
    }
    if (r.explicit_funnel_param) {
        lines.push(`  This URL carries ?f=${safeText(r.explicit_funnel_param)}, which wins outright regardless of entry pages or overrides.`);
    }

    lines.push('');
    if (r.domain?.domain) {
        const page = r.page ? `  page ${r.page.title ? safeText(r.page.title) + ' ' : ''}${c.dim(`/${safeText(r.page.slug ?? '')}${r.page.id != null ? ` #${r.page.id}` : ''}`)}` : '';
        lines.push(`${c.bold('Loads')}       ${safeText(r.domain.domain)}${page}`);
    }
    const q = r.context?.query ?? {};
    const qKeys = Object.keys(q);
    const aff = r.context?.affiliate;
    if ((aff != null && aff !== '') || qKeys.length) {
        const parts: string[] = [];
        if (aff != null && aff !== '') parts.push(`affiliate ${safeText(aff)}`);
        if (qKeys.length) parts.push(qKeys.map((k) => `${safeText(k)}=${safeText(q[k])}`).join(' · '));
        lines.push(`${c.bold('From URL')}    ${parts.join(' · ')}`);
    }
    const next = r.next;
    if (next?.merchant) {
        const m = next.merchant;
        lines.push(`${c.bold('Merchant')}    ${m.name ? safeText(m.name) : `#${m.id ?? '?'}`}${m.gateway ? c.dim(` (${safeText(m.gateway)})`) : ''}${m.from_events ? ', picked by a page event rule' : ''}`);
    }
    if (next?.redirects_to) lines.push(c.yellow(`A visitor to this URL is redirected to ${safeText(next.redirects_to)}.`));

    if (next && ((next.after_buy?.length ?? 0) > 0 || next.after_decline)) {
        lines.push('', c.bold('After a purchase'));
        for (const g of next.after_buy ?? []) {
            const products = (g.products ?? []).map((p) => (p.name ? `${safeText(p.name)} (${safeText(p.code)})` : safeText(p.code))).join(', ');
            lines.push(`  ${products || '(products)'} → ${destination(g.to)}`);
        }
        if (next.after_decline) lines.push(`  No thanks → ${destination(next.after_decline)}`);
    }

    const trace = r.trace ?? [];
    const decisive = trace.filter((row) => (row.step === 'trigger_overrides' && row.outcome === 'matched') || (row.step === 'result' && row.outcome === 'no_funnel'));
    const groups = new Map<string, FunnelResolveTraceRow[]>();
    for (const row of trace) {
        const reason = eliminationReason(row);
        if (reason) groups.set(reason, [...(groups.get(reason) ?? []), row]);
    }
    if (decisive.length || groups.size) {
        lines.push('', c.bold('Why'));
        for (const row of decisive) {
            if (row.step === 'trigger_overrides') {
                lines.push(`  ${c.green('✓')} ${funnelName(r, row.funnel_id, row.funnel_code)} matched its trigger override.`);
                for (const l of conditionLines(r, row)) lines.push(`    ${l}`);
            } else {
                lines.push(`  ${c.yellow('!')} ${row.reason === 'default_filtered_out_by_entry_pages'
                    ? 'The domain default was excluded by its own entry pages.'
                    : 'No default funnel is assigned to this domain.'}`);
            }
        }
        if (!decisive.length && r.winner && r.won_via !== 'trigger_override_won') {
            lines.push(`  No trigger override matched, so the domain default runs.`);
        }
        const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
        if (total) {
            lines.push(`  ${c.dim(`Other funnels evaluated (${total}):`)}`);
            for (const [reason, label] of ELIMINATED) {
                const rows = groups.get(reason);
                if (!rows) continue;
                const names = rows.slice(0, limit).map((row) => funnelName(r, row.funnel_id, row.funnel_code));
                const more = rows.length > limit ? c.dim(` +${rows.length - limit} more (--json lists all)`) : '';
                lines.push(`    ${rows.length}  ${label}: ${names.join(', ')}${more}`);
            }
        }
    }
    return lines;
}

/** Message for a `resolved: false` answer, and the exit code it maps to. */
export function unresolvedMessage(r: FunnelResolveResult): { message: string; code: ExitCodeValue } {
    if (r.reason === 'page_not_found') {
        return { message: `No page is served at ${safeText(r.path ?? '/')} on ${safeText(r.host ?? '')}. Check the slug with "ef pages list".`, code: ExitCode.NotFound };
    }
    return { message: 'The page runtime did not return a funnel for this URL.', code: ExitCode.Server };
}
