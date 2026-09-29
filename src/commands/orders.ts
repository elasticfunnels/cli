import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { ConversionRow, Product } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';
import { ResolvedRange } from '../utils/dateRange';
import { buildBuyerTable, BuyerGroup, orderPageId, orderProductCodes, orderTotal, stripPii } from '../utils/orders';
import { formatInTz, idFlag, positiveInt, RangeFlags, resolveReportRange, withRangeFlags } from './reportFlags';

/**
 * `ef orders` — the brand's orders, read-only.
 *
 * Built so funnel analysis stops reaching into the CLI's internal ApiClient
 * with `node -e`. Every subcommand is a GET against the same endpoint the
 * dashboard's Orders list uses (`/conversions`), scoped to this folder's brand
 * by its key.
 *
 * PII: customer email / name / phone / address / IP never reach the terminal
 * in human output, and `--json` strips them too unless `--include-pii` is
 * passed. `ef orders buyers` needs emails to tell buyers apart; it hashes them
 * in memory and prints only aggregates.
 */

const ORDER_TYPES = ['purchase', 'refund', 'chargeback'] as const;
const PER_PAGE = 100;

interface ScopeFlags { funnel?: string; aff?: string; page?: string }

function scopeParams(opts: ScopeFlags, range: ResolvedRange): Record<string, unknown> {
    const params: Record<string, unknown> = { start: range.start, end: range.end, tz: range.tz };
    const funnel = idFlag('funnel', opts.funnel);
    const page = idFlag('page', opts.page);
    if (funnel != null) params['filter[funnel_id]'] = funnel;
    if (page != null) params['filter[page_id]'] = page;
    if (opts.aff) params['filter[aff_id]'] = opts.aff;
    return params;
}

/** Page through the list until `limit` rows (or the end). `limit` null = everything. */
async function fetchOrders(api: ApiClient, brandId: number, params: Record<string, unknown>, limit: number | null): Promise<{ rows: ConversionRow[]; total: number }> {
    const rows: ConversionRow[] = [];
    let total = 0;
    for (let page = 1; ; page++) {
        const perPage = limit == null ? PER_PAGE : Math.min(PER_PAGE, limit - rows.length);
        const res = await api.listConversions(brandId, { ...params, per_page: perPage, page });
        total = res.total;
        rows.push(...res.data);
        if (res.data.length === 0 || page >= res.last_page) break;
        if (limit != null && rows.length >= limit) break;
    }
    return { rows: limit == null ? rows : rows.slice(0, limit), total };
}

function money(n: number | null | undefined): string {
    return n == null ? '-' : n.toFixed(2);
}

function pct(n: number, d: number): string {
    return d ? `${((n / d) * 100).toFixed(1)}%` : '-';
}

function rangeLine(range: ResolvedRange): string {
    const span = range.start === range.end ? range.start : `${range.start} → ${range.end}`;
    return `${c.bold(range.label)} ${c.dim(`(${span}, ${range.tz})`)}`;
}

export function registerOrdersCommand(program: Command): void {
    const cmd = program
        .command('orders')
        .description('Orders for this brand (read-only): list them, or build the per-buyer upsell take table.');

    // ── ef orders list ───────────────────────────────────────────────
    withRangeFlags(
        cmd.command('list')
            .alias('ls')
            .description('List orders (purchases, refunds, chargebacks) with product, page, affiliate and session.'),
    )
        .option('--funnel <id>', 'Only orders in this funnel.')
        .option('--aff <id>', 'Only orders from this affiliate (merchant affiliate id).')
        .option('--page <id>', 'Only orders placed on this page.')
        .option('--type <type>', `Only one order type: ${ORDER_TYPES.join(' | ')}. Default: all three.`)
        .option('--limit <n>', 'Max orders to fetch.', '50')
        .option('--all', 'Fetch every order in range (pages through 100 at a time).')
        .option('--include-pii', 'With --json: keep customer email/name/phone/address/IP. Never printed in the table.')
        .option('--json', 'Print as JSON (customer PII stripped unless --include-pii).')
        .addHelpText('after', `
Examples:
  $ ef orders list --funnel 42 --range 30d
  $ ef orders list --type refund --range 90d --all --json
  $ ef orders list --aff 4021 --page 312 --range 7d
  $ ef sessions show <session_id>        # the visit behind an order

Dates filter purchased_at, counted in --tz (default: analyticsTz, else this
machine's zone). --aff matches the merchant-side affiliate id and needs the
affiliates.view permission; without it the server ignores the filter.`)
        .action(async (opts: RangeFlags & ScopeFlags & { type?: string; limit?: string; all?: boolean; includePii?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const range = resolveReportRange(rt, opts, '7d');
            const params = scopeParams(opts, range);
            if (opts.type) {
                const t = opts.type.toLowerCase();
                if (!(ORDER_TYPES as readonly string[]).includes(t)) {
                    throw new CliError(ExitCode.Validation, `--type must be one of ${ORDER_TYPES.join(', ')}. Got "${opts.type}".`);
                }
                params.type = t;
            }
            if (opts.includePii && !opts.json) {
                throw new CliError(ExitCode.Validation, '--include-pii only applies to --json. The table never prints customer details.');
            }
            const limit = opts.all ? null : positiveInt('limit', opts.limit, 50);
            const { rows, total } = await fetchOrders(api, rt.config.brandId, params, limit);

            if (opts.json) {
                log.json({
                    ok: true,
                    brand_id: rt.config.brandId,
                    range: { start: range.start, end: range.end, tz: range.tz },
                    total,
                    count: rows.length,
                    pii: !!opts.includePii,
                    orders: opts.includePii ? rows : rows.map(r => stripPii(r)),
                });
                return;
            }

            log.info(rangeLine(range));
            if (rows.length === 0) { log.info('No orders in this range.'); return; }
            const table = rows.map(r => [
                formatInTz(r.purchased_at ?? r.created_at, range.tz),
                String(r.code ?? ''),
                String(r.type ?? ''),
                orderProductCodes(r).join(', '),
                money(orderTotal(r)) + (r.currency_code && r.currency_code !== 'USD' ? ` ${r.currency_code}` : ''),
                r.page?.slug ? `${r.page.slug} (${orderPageId(r)})` : String(orderPageId(r) ?? '-'),
                String(r.aff_id ?? '-'),
                String(r.session_id ?? '-'),
            ]);
            process.stdout.write(renderTable({ head: ['DATE', 'ORDER', 'TYPE', 'PRODUCTS', 'TOTAL', 'PAGE', 'AFF', 'SESSION'], rows: table, maxCellWidth: 48 }) + '\n');
            log.detail(`${rows.length} of ${total} order(s)${rows.length < total ? ' — raise --limit or pass --all for more' : ''}.`);
        });

    // ── ef orders buyers ─────────────────────────────────────────────
    withRangeFlags(
        cmd.command('buyers')
            .description('Per-buyer upsell take table: what each front-end package\'s buyers went on to buy.'),
        '30d',
    )
        .requiredOption('--funnel <id>', 'The funnel to analyse.')
        .option('--aff <id>', 'Only buyers from this affiliate.')
        .option('--bump <codes>', 'Extra order-bump product codes (comma-separated), on top of products classified "bump"/"bonus".')
        .option('--window <minutes>', 'A purchase later than this after the package is a repeat order, not a take.', '1440')
        .option('--by <view>', 'Group by the front-end "product" (default) or the "page" the package was bought on.', 'product')
        .option('--json', 'Print the aggregated table as JSON (no customer data).')
        .addHelpText('after', `
How buyers are counted:
  Purchases are grouped per customer (a hash of the email, or the session when
  an order has no email) and ordered by purchased_at. The first purchase with a
  non-bump product is the PACKAGE (its first non-bump code is the front end);
  every later non-bump product bought within --window minutes is a TAKE, with
  the page it was bought on. Products whose classification is "bump" or
  "bonus" (see "ef products list --json"), plus any --bump codes, count as
  BUMP, never as a take. Refunds, test orders and exact duplicate IPNs are
  ignored.

Examples:
  $ ef orders buyers --funnel 42 --range 30d
  $ ef orders buyers --funnel 42 --by page
  $ ef orders buyers --funnel 42 --aff 4021 --bump priority_ship
  $ ef orders buyers --funnel 42 --json | jq '.groups[] | {key, buyers, take_rate}'

A buyer whose package was bought BEFORE the range but upsold inside it shows
up with the upsell as its package — widen the range if that matters.`)
        .action(async (opts: RangeFlags & ScopeFlags & { bump?: string; window?: string; by?: string; json?: boolean }) => {
            const by = (opts.by ?? 'product').toLowerCase();
            if (by !== 'product' && by !== 'page') throw new CliError(ExitCode.Validation, `--by must be "product" or "page". Got "${opts.by}".`);
            const windowMinutes = positiveInt('window', opts.window, 1440);
            const extraBumps = (opts.bump ?? '').split(',').map(s => s.trim()).filter(Boolean);

            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const range = resolveReportRange(rt, opts, '30d');
            const params = { ...scopeParams({ funnel: opts.funnel, aff: opts.aff }, range), type: 'purchase' };

            const [{ rows }, products, pages] = await Promise.all([
                fetchOrders(api, rt.config.brandId, params, null),
                api.listProducts(rt.config.brandId).catch(() => [] as Product[]),
                api.listPages(rt.config.brandId, 100000, { allTypes: true }).catch(() => []),
            ]);
            // Bumps come from the product records themselves — `classification`
            // is set per product in the dashboard — so no brand-specific code
            // has to be remembered. --bump adds to that set.
            const bumps = new Set<string>(extraBumps);
            for (const cls of ['bump', 'bonus']) {
                for (const p of products) if (p.code && p.classification === cls) bumps.add(String(p.code));
            }
            if (products.length === 0 && extraBumps.length === 0) {
                log.warn('Could not read products, so no bump codes are known — pass --bump <codes> or bumps will count as takes.');
            }
            const table = buildBuyerTable(rows, { bumps, windowMinutes, by: by as 'product' | 'page' });
            const productByCode = new Map(products.filter(p => p.code).map(p => [String(p.code), p]));
            // A variant has no slug of its own — it answers under its parent's — so
            // it is named by its variant slug.
            const slugById = new Map(pages.map(p => [p.id, p.slug ?? p.variant_slug ?? String(p.id)]));
            const pageLabel = (id: number) => slugById.get(id) ?? String(id);
            const listPrice = (code: string): number | null => {
                const p = productByCode.get(code) as (Product & { price?: unknown }) | undefined;
                const n = Number(p?.price);
                return p && Number.isFinite(n) ? n : null;
            };

            if (opts.json) {
                log.json({
                    ok: true,
                    brand_id: rt.config.brandId,
                    funnel_id: Number(opts.funnel),
                    aff_id: opts.aff ?? null,
                    range: { start: range.start, end: range.end, tz: range.tz },
                    by,
                    bumps: [...bumps],
                    window_minutes: windowMinutes,
                    orders: rows.length,
                    buyers: table.buyers,
                    took_any: table.took_any,
                    bump_only: table.bump_only,
                    later_orders: table.later_orders,
                    duplicates: table.duplicates,
                    groups: table.groups.map(g => ({
                        ...g,
                        label: by === 'page' ? (g.key === '(none)' ? g.key : pageLabel(Number(g.key))) : (productByCode.get(g.key)?.title ?? null),
                        list_price: by === 'product' ? listPrice(g.key) : null,
                        offers: g.offers.map(o => ({ ...o, title: productByCode.get(o.code)?.title ?? null, page_slugs: o.pages.map(pageLabel) })),
                    })),
                });
                return;
            }

            log.info(`${c.bold(`Buyers — funnel #${opts.funnel}`)}${opts.aff ? c.bold(`, affiliate ${opts.aff}`) : ''}  ${rangeLine(range)}`);
            if (table.buyers === 0) {
                log.info('No purchases in this range.');
                return;
            }

            const groupLabel = (g: BuyerGroup): string => by === 'page'
                ? (g.key === '(none)' ? '(no page)' : `${pageLabel(Number(g.key))} (${g.key})`)
                : g.key;
            const head = by === 'page'
                ? ['FIRST PAGE', 'PACKAGES', 'BUYERS', 'TOOK ANY', 'TAKE %', 'BUMP', 'MEDIAN PAID']
                : ['FRONT END', 'TITLE', 'LIST', 'MEDIAN PAID', 'BUYERS', 'TOOK ANY', 'TAKE %', 'BUMP'];
            const main = table.groups.map(g => by === 'page'
                ? [groupLabel(g), g.packages.join(', '), String(g.buyers), String(g.took_any), pct(g.took_any, g.buyers), String(g.bump_buyers), money(g.median_paid)]
                : [g.key, productByCode.get(g.key)?.title ?? '', money(listPrice(g.key)), money(g.median_paid), String(g.buyers), String(g.took_any), pct(g.took_any, g.buyers), String(g.bump_buyers)]);
            main.push(by === 'page'
                ? [c.bold('TOTAL'), '', String(table.buyers), String(table.took_any), pct(table.took_any, table.buyers), '', '']
                : [c.bold('TOTAL'), '', '', '', String(table.buyers), String(table.took_any), pct(table.took_any, table.buyers), '']);
            process.stdout.write(renderTable({ head, rows: main, maxCellWidth: 48 }) + '\n');

            const takes = table.groups.flatMap(g => g.offers.map(o => [
                groupLabel(g),
                o.code,
                productByCode.get(o.code)?.title ?? '',
                String(o.buyers),
                pct(o.buyers, g.buyers),
                o.pages.map(pageLabel).join(', '),
            ]));
            if (takes.length > 0) {
                process.stdout.write(`\n${c.bold('Takes by offer')}\n`);
                process.stdout.write(renderTable({ head: [by === 'page' ? 'FIRST PAGE' : 'FRONT END', 'OFFER', 'TITLE', 'BUYERS', '% OF GROUP', 'BOUGHT ON'], rows: takes, maxCellWidth: 48 }) + '\n');
            } else {
                log.info('\nNo buyer took an upsell or downsell in this range.');
            }

            const notes = [
                `${rows.length} purchase row(s)`,
                `bump/bonus codes: ${bumps.size === 0 ? '(none)' : bumps.size <= 4 ? [...bumps].join(', ') : `${[...bumps].slice(0, 3).join(', ')} +${bumps.size - 3} more (--json lists them)`}`,
                `take window ${windowMinutes} min`,
            ];
            if (table.duplicates) notes.push(`${table.duplicates} duplicate row(s) dropped`);
            if (table.later_orders) notes.push(`${table.later_orders} repeat order(s) after the window not counted as takes`);
            if (table.bump_only) notes.push(`${table.bump_only} bump-only buyer(s) skipped`);
            log.detail(notes.join(' · ') + '.');
        });
}
