import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { ClickRow, SessionEvent } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';
import { brandHostsFrom, displayUrl, findTrackingGaps, firstEventValue, NOISY_EVENTS, pagePath, sortEvents } from '../utils/sessions';
import { formatInTz, idFlag, positiveInt, RangeFlags, resolveReportRange, withRangeFlags } from './reportFlags';

/**
 * `ef sessions` — tracked visits, read-only.
 *
 * A click is one page load; a session is the clicks (and their events) that
 * share a session_id. `list` reads the clicks list the dashboard's Sessions
 * screen uses; `show` reads one session's full event timeline — the tool for
 * confirming a funnel finding on a real visit.
 *
 * The visitor's IP, coordinates and zip are in the payload and stay out of the
 * human output; `--json` prints the server payload as-is.
 */

const yesNo = (v: unknown): string => (v === true ? c.yellow('yes') : v === false ? 'no' : '-');

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function clickHosting(row: ClickRow): unknown {
    return row.d_is_hosting ?? firstEventValue(row.events ?? [], 'd_is_hosting', 'is_hosting');
}

export function registerSessionsCommand(program: Command): void {
    const cmd = program
        .command('sessions')
        .description('Tracked visits (read-only): list page loads, or show one session\'s event timeline.');

    // ── ef sessions list ─────────────────────────────────────────────
    withRangeFlags(
        cmd.command('list')
            .alias('ls')
            .description('List recent page loads (clicks) with session id, device, country and bot/hosting flags.'),
        'today',
    )
        .option('--funnel <id>', 'Only visits in this funnel.')
        .option('--aff <id>', 'Only visits from this affiliate.')
        .option('--page <id>', 'Only loads of this page.')
        .option('--exclude-bots', 'Drop bot, hosting, VPN, proxy and Tor traffic (server-side).')
        .option('--limit <n>', 'Max rows.', '30')
        .option('--json', 'Print the server rows as JSON.')
        .addHelpText('after', `
Examples:
  $ ef sessions list --funnel 42
  $ ef sessions list --page 312 --range 7d --limit 100
  $ ef sessions list --aff 4021 --exclude-bots --json
  $ ef sessions show <session_id>

One row is one page load, newest first; a session with five pages is five rows.
HOSTING=yes means the IP belongs to a datacenter — on a "real" visit that is
usually a bot, a VPN or a privacy relay, and it inflates sessions without buying.`)
        .action(async (opts: RangeFlags & { funnel?: string; aff?: string; page?: string; excludeBots?: boolean; limit?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const range = resolveReportRange(rt, opts, 'today');
            const limit = positiveInt('limit', opts.limit, 30);
            const params: Record<string, unknown> = { start: range.start, end: range.end, tz: range.tz };
            const funnel = idFlag('funnel', opts.funnel);
            const page = idFlag('page', opts.page);
            if (funnel != null) params['filter[funnel_id]'] = funnel;
            // The clicks controller reads the page as `pgid`, not `page_id`.
            if (page != null) params['filter[pgid]'] = page;
            if (opts.aff) params['filter[aff_id]'] = opts.aff;
            if (opts.excludeBots) params['filter[exclude_bots]'] = 'true';

            const rows: ClickRow[] = [];
            let total = 0;
            for (let p = 1; rows.length < limit; p++) {
                const res = await api.listClicks(rt.config.brandId, { ...params, per_page: Math.min(100, limit - rows.length), page: p });
                total = res.total;
                rows.push(...res.data);
                if (res.data.length === 0 || p >= res.last_page) break;
            }

            if (opts.json) {
                log.json({ ok: true, brand_id: rt.config.brandId, range: { start: range.start, end: range.end, tz: range.tz }, total, count: rows.length, clicks: rows });
                return;
            }

            const span = range.start === range.end ? range.start : `${range.start} → ${range.end}`;
            log.info(`${c.bold(range.label)} ${c.dim(`(${span}, ${range.tz})`)}`);
            if (rows.length === 0) { log.info('No visits in this range.'); return; }
            const table = rows.map(r => [
                formatInTz(r.created_at, range.tz, true),
                String(r.session_id ?? '-'),
                String(r.events?.length ?? 0),
                String(r.d_device_type ?? '-'),
                String(r.d_country_code ?? '-'),
                yesNo(clickHosting(r)),
                yesNo(r.d_is_bot),
                truncate(String(r.user_agent ?? ''), 40),
                displayUrl(r.url),
            ]);
            process.stdout.write(renderTable({
                head: ['TIME', 'SESSION', 'EVENTS', 'DEVICE', 'COUNTRY', 'HOSTING', 'BOT', 'USER AGENT', 'PATH'],
                rows: table,
                maxCellWidth: 60,
            }) + '\n');
            log.detail(`${rows.length} of ${total} page load(s). "ef sessions show <session>" for one visit's timeline.`);
        });

    // ── ef sessions show <id> ────────────────────────────────────────
    cmd.command('show <sessionId>')
        .description('One session: visit summary, the pages it went through, and its event timeline.')
        .option('--full-urls', 'Keep query strings (click ids, tracking params) in URLs.')
        .option('--all-events', `Include the high-volume events hidden by default (${[...NOISY_EVENTS].join(', ')}).`)
        .option('--tz <zone>', 'Timezone for timestamps. Defaults to analyticsTz, else this machine\'s.')
        .option('--json', 'Print the server payload as JSON (includes IP and geo).')
        .addHelpText('after', `
Examples:
  $ ef sessions show Uk54cvvIMp_b_G1PCNY7mXa97vGZTHVw
  $ ef sessions show <session_id> --all-events --full-urls
  $ ef orders list --funnel 42 | …   # the SESSION column feeds this command

<sessionId> may also be a click code. A "buy-link" event with no page-view
before it is flagged as a TRACKING GAP: the page the buyer clicked on never
recorded its view, so that page's conversion rate is understated.`)
        .action(async (sessionId: string, opts: { fullUrls?: boolean; allEvents?: boolean; tz?: string; json?: boolean }) => {
            if (!sessionId.trim()) throw new CliError(ExitCode.Validation, 'Pass a session id.');
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const tz = resolveReportRange(rt, { tz: opts.tz }, 'today').tz;
            const data = await api.getSessionDetails(rt.config.brandId, sessionId.trim());

            if (opts.json) { log.json(data); return; }
            if (data.events.length === 0 && !data.visit) {
                throw new CliError(ExitCode.NotFound, `No session "${sessionId}" in this brand (or it has no tracked events).`);
            }

            const events = sortEvents(data.events);
            const hosts = brandHostsFrom(data.domains);
            const v = data.visit ?? {};
            const geo = (Array.isArray(data.geoData) ? {} : data.geoData) as { city?: string | null; region?: string | null; country?: string | null };
            const affId = firstEventValue(events, 'aff_id');
            const funnelId = v.funnel_id ?? firstEventValue(events, 'funnel_id');
            const flag = (name: string, val: unknown) => (val === true ? c.yellow(`${name}: YES`) : `${name}: ${val === false ? 'no' : '-'}`);

            const summary: Array<[string, string]> = [
                ['Session', sessionId],
                ['Started', formatInTz(v.created_at ?? events[0]?.created_at, tz, true) + c.dim(` (${tz})`)],
                ['Landing', displayUrl(v.url, { full: opts.fullUrls, brandHosts: hosts }) + (v.url && !opts.fullUrls ? c.dim(` on ${safeHost(v.url)}`) : '')],
                ['Referrer', v.referrer ? displayUrl(v.referrer, { full: opts.fullUrls }) : '-'],
                ['Affiliate', affId != null ? String(affId) : '-'],
                ['Funnel', funnelId != null ? String(funnelId) : '-'],
                ['Device', [v.d_device_type, v.d_os, v.d_browser].filter(Boolean).join(' / ') || '-'],
                ['Country', [geo.country, geo.region, geo.city].filter(Boolean).join(' / ') || '-'],
                ['User agent', String(v.user_agent ?? '-')],
                ['Flags', [flag('bot', v.d_is_bot), flag('hosting', v.d_is_hosting), flag('vpn', v.d_is_vpn), flag('proxy', v.d_is_proxy), flag('tor', v.d_is_tor)].join('  ')],
                ['Page loads', String(v.click_count ?? '-')],
                ['Path', pagePath(events, { brandHosts: hosts }).join(' → ') || '-'],
            ];
            const w = Math.max(...summary.map(([k]) => k.length));
            for (const [k, val] of summary) process.stdout.write(`${c.bold(k.padEnd(w))}  ${val}\n`);

            const gaps = new Set(findTrackingGaps(events));
            const shown: Array<[SessionEvent, number]> = [];
            let hidden = 0;
            events.forEach((e, i) => {
                if (!opts.allEvents && NOISY_EVENTS.has(String(e.event)) && !gaps.has(i)) { hidden++; return; }
                shown.push([e, i]);
            });

            process.stdout.write(`\n${c.bold('Timeline')}\n`);
            const rows = shown.map(([e, i]) => [
                formatInTz(e.created_at, tz, true).slice(11),
                String(e.event ?? ''),
                e.page_id ? String(e.page_id) : '-',
                displayUrl(e.url, { full: opts.fullUrls, brandHosts: hosts }),
                gaps.has(i) ? c.red('TRACKING GAP: buy-link with no earlier page-view') : (Array.isArray(e.product_codes) && /^(buy-link|upsell-|downsell-)/.test(String(e.event)) ? e.product_codes.join(', ') : ''),
            ]);
            process.stdout.write(renderTable({ head: ['TIME', 'EVENT', 'PAGE', 'URL', 'NOTE'], rows, maxCellWidth: opts.fullUrls ? 400 : 70 }) + '\n');
            const notes = [`${events.length} event(s)`];
            if (hidden) notes.push(`${hidden} ${[...NOISY_EVENTS].join('/')} hidden (--all-events)`);
            if (gaps.size) notes.push(c.red(`${gaps.size} tracking gap(s)`));
            log.detail(notes.join(' · ') + '.');
        });
}

function safeHost(url: string): string {
    try { return new URL(url).host; } catch { return ''; }
}
