import { Command } from 'commander';
import { ApiClient, AnalyticsQuery } from '../api/client';
import { AnalyticsCard, AnalyticsGroupRow, AnalyticsMetricDef, AnalyticsMetricValue } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime, EfRuntime } from '../utils/store';
import { renderTable } from '../utils/format';
import { RANGE_PRESETS, ResolvedRange, resolveRange } from '../utils/dateRange';

/**
 * `ef stats` — the brand's own analytics, in the terminal.
 *
 * Scope follows the same rule as every other command: the folder is bound to
 * one brand and the key in `.ef/auth` only opens that brand, so these numbers
 * are always this brand's. There is no account-wide roll-up to ask for.
 *
 * The metric registry is *discovered*, never hardcoded — the server assembles
 * it per request from the brand's plan modules and the caller's role
 * permissions, so two brands on the same release legitimately expose different
 * metrics. `ef stats metrics` prints whatever this brand actually has.
 */

/**
 * What `ef stats` shows when asked for nothing in particular.
 *
 * Taken from the app's own "General" preset dashboard rather than invented, so
 * the terminal opens on the same five numbers the web dashboard does. Any that
 * a brand's plan does not include simply come back absent, and are reported as
 * unavailable rather than as zero.
 */
const DEFAULT_METRICS = ['revenue', 'sessions', 'conversion_rate', 'sales', 'aov'];

/**
 * Dimensions that are an axis of time. Grouping on one of these produces a
 * series, which is ordered by the bucket rather than by the value.
 */
const TEMPORAL_FIELDS = new Set(['hour', 'day', 'week', 'month', 'year', 'hour_of_day']);

/** Metrics used for a split-test read, where conversion is the whole question. */
const DEFAULT_SPLIT_METRICS = ['sessions', 'conversion_rate', 'revenue', 'sales'];

interface RangeFlags {
    range?: string;
    from?: string;
    to?: string;
    tz?: string;
}

interface ScopeFlags {
    page?: string;
    funnel?: string;
    splitTest?: string;
    aff?: string;
}

/** Attach the range + scope flags every stats subcommand shares. */
function withCommonFlags(cmd: Command): Command {
    return cmd
        .option('-m, --metrics <list>', 'Comma-separated metric keys. "ef stats metrics" lists them.')
        // No commander default: an always-present `--range` would make the
        // "--range or --from/--to, not both" check fire on every explicit
        // --from, which locked that path out entirely. `resolveRange` applies
        // the 7d default instead, where it can tell "unset" from "passed".
        .option('-r, --range <preset>', `Named range: ${RANGE_PRESETS.join(', ')}, or <n>d. Default: 7d.`)
        .option('--from <date>', 'First day, YYYY-MM-DD. Overrides --range.')
        .option('--to <date>', 'Last day, YYYY-MM-DD. Defaults to today.')
        .option('--tz <zone>', 'IANA timezone the days are counted in. Defaults to this machine\'s.')
        .option('--page <id>', 'Only sessions on this page.')
        .option('--funnel <id>', 'Only sessions in this funnel.')
        .option('--split-test <id>', 'Only sessions in this split test.')
        .option('--aff <id>', 'Only sessions from this affiliate.')
        .option('--json', 'Print as JSON.');
}

/** Turn `--page 12` into a number, rejecting junk rather than sending NaN. */
function numericFlag(name: string, raw: string | undefined): number | undefined {
    if (raw == null) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        throw new CliError(ExitCode.Validation, `--${name} takes a numeric id. Got "${raw}".`);
    }
    return n;
}

/** Build the query the client sends, from the parsed flags. */
function buildQuery(rt: EfRuntime, opts: RangeFlags & ScopeFlags): AnalyticsQuery & { range: ResolvedRange } {
    const range = resolveRange(opts, rt.config.analyticsTz);
    return {
        start: range.start,
        end: range.end,
        tz: range.tz,
        pageId: numericFlag('page', opts.page),
        funnelId: numericFlag('funnel', opts.funnel),
        splitTestId: numericFlag('split-test', opts.splitTest),
        affiliateId: opts.aff,
        range,
    };
}

function parseMetrics(raw: string | undefined, fallback: string[]): string[] {
    if (!raw) return fallback;
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0) {
        throw new CliError(ExitCode.Validation, '--metrics was empty. Pass keys like "revenue,sessions".');
    }
    return list;
}

/**
 * One metric, reduced to what a reader needs.
 *
 * The raw payload carries the comparison window twice over, plus rendering
 * hints. We keep the number, the server's own formatting of it, and the
 * direction — and drop the rest, which is dashboard chrome.
 */
function slimMetric(key: string, v: AnalyticsMetricValue): Record<string, unknown> {
    return {
        metric: key,
        value: v.value,
        formatted: v.formatted_value ?? String(v.value),
        change_percent: v.change_percent ?? null,
        change: v.change ?? null,
        previous_value: v.previous_value ?? null,
        vs: v.previous_range_label ?? null,
    };
}

/**
 * The range line above a table. An explicit `--from/--to` labels itself with
 * the same span it would then repeat in the parenthetical, so that case prints
 * the days once.
 */
function rangeHeader(range: ResolvedRange): string {
    const span = range.start === range.end ? range.start : `${range.start} → ${range.end}`;
    return range.label === span
        ? `${c.bold(span)} ${c.dim(`(${range.tz})`)}`
        : `${c.bold(range.label)} ${c.dim(`(${span}, ${range.tz})`)}`;
}

/** Colour a delta by whether it is good, which is per-metric, not per-sign. */
function paintChange(v: AnalyticsMetricValue): string {
    const pct = v.change_percent;
    if (pct == null || pct === 0) return c.dim('—');
    // `change_percent` already carries its own sign, and `change_symbol` repeats
    // it — using both printed "--65.19%". Derive the sign from the number alone.
    const text = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    if (v.neutral) return c.dim(text);
    // A rise in cost metrics is a loss. `lower_is_better` is why we read this
    // from the server instead of assuming up is green.
    const good = v.lower_is_better ? pct < 0 : pct > 0;
    return good ? c.green(text) : c.red(text);
}

export function registerStatsCommand(program: Command): void {
    const cmd = program
        .command('stats')
        .description('Analytics for this brand: KPIs, breakdowns and split-test results.');

    // ── ef stats ─────────────────────────────────────────────────────
    const summary = withCommonFlags(
        cmd.command('summary', { isDefault: true })
            .description('Headline metrics for a date range (the default subcommand).'),
    );
    summary
        .addHelpText('after', `
Examples:
  $ ef stats                                   # last 7 days, default metrics
  $ ef stats --range today
  $ ef stats --metrics revenue,cpc,clicks,sessions --range 30d
  $ ef stats --from 2026-08-01 --to 2026-08-18 --tz Europe/Bucharest
  $ ef stats --split-test 321 --metrics aov,cpc,clicks,sessions
  $ ef stats --json | jq '.metrics[] | {metric, value}'

Days are counted in --tz. Without it the CLI sends this machine's zone — the
API's own fallback is America/Los_Angeles, which would shift every boundary.`)
        .option('--raw', 'Print the server payload unreduced (implies --json).')
        .action(async (opts: RangeFlags & ScopeFlags & { metrics?: string; json?: boolean; raw?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const q = buildQuery(rt, opts);
            const wanted = parseMetrics(opts.metrics, DEFAULT_METRICS);

            const data = await api.getAnalyticsMetrics(rt.config.brandId, { ...q, metrics: wanted });

            if (opts.raw) { log.json(data); return; }

            // The response can carry metrics we did not request — the resolver
            // pulls in whatever a requested metric is derived from. Report the
            // selection, in the order it was asked for.
            const present = wanted.filter(k => data[k] != null);
            const missing = wanted.filter(k => data[k] == null);

            if (opts.json) {
                log.json({
                    ok: true,
                    brand_id: rt.config.brandId,
                    range: { start: q.start, end: q.end, tz: q.tz },
                    metrics: present.map(k => slimMetric(k, data[k])),
                    unavailable: missing,
                });
                return;
            }

            log.info(rangeHeader(q.range));
            if (present.length === 0) {
                log.warn('None of those metrics are available for this brand.');
                log.detail('Run "ef stats metrics" for the list this brand actually exposes.');
                return;
            }
            const rows = present.map(k => {
                const v = data[k];
                return [k, v.formatted_value ?? String(v.value), paintChange(v), v.previous_range_label ?? ''];
            });
            process.stdout.write(renderTable({ head: ['METRIC', 'VALUE', 'CHANGE', 'VS'], rows }) + '\n');
            if (missing.length > 0) {
                log.detail(`Not available for this brand: ${missing.join(', ')}. "ef stats metrics" lists what is.`);
            }
        });

    // ── ef stats metrics ─────────────────────────────────────────────
    cmd.command('metrics')
        .description('List the metric keys this brand can report on.')
        .option('--split-tests', 'Only metrics valid inside a split test.')
        .option('--group <name>', 'Only one registry group (e.g. "Revenue & Sales").')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { splitTests?: boolean; group?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            let metrics = await api.listAnalyticsMetrics(rt.config.brandId, { splitTests: opts.splitTests });

            if (opts.group) {
                const needle = opts.group.toLowerCase();
                metrics = metrics.filter(m => (m.group_name ?? '').toLowerCase().includes(needle));
            }

            if (opts.json) { log.json({ ok: true, count: metrics.length, metrics }); return; }
            if (metrics.length === 0) {
                log.info(opts.group ? `No metrics in a group matching "${opts.group}".` : 'No metrics available for this brand.');
                return;
            }

            const byGroup = new Map<string, AnalyticsMetricDef[]>();
            for (const m of metrics) {
                const g = m.group_name ?? 'General';
                if (!byGroup.has(g)) byGroup.set(g, []);
                byGroup.get(g)!.push(m);
            }
            for (const [group, list] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0]))) {
                log.info(`\n${c.bold(group)}`);
                const rows = list.map(m => [m.type, m.name, m.info ?? '']);
                process.stdout.write(renderTable({ head: ['KEY', 'NAME', 'WHAT IT COUNTS'], rows, maxCellWidth: 60 }) + '\n');
            }
            log.detail(`\n${metrics.length} metric(s). Pass any of these to --metrics.`);
        });

    // ── ef stats cards ───────────────────────────────────────────────
    cmd.command('cards')
        .description('List the dashboard cards available, and where each one can resolve.')
        .addHelpText('after', `
Examples:
  $ ef stats cards                             # the whole catalog
  $ ef stats cards --scope page                # only what a page report can show
  $ ef stats cards --scope split_test
  $ ef stats cards --category product_analytics
  $ ef stats cards --json | jq -r '.cards[] | select(.scopes[] == "funnel") | .key'

A card's SCOPES are where its number means what its heading says. A card missing
"page" is not merely unstyled there — its data source ignores the page filter, so
it would answer with the brand's figure under that page's heading. The scope names
are the server's; an unknown one comes back with the real list.

Cards are a WEB dashboard concept: this lists them, it does not render them. For
numbers in the terminal use "ef stats" and "ef stats by <field>".`)
        .option('--scope <name>', 'Only cards that can resolve in this scope (page, funnel, split_test, …).')
        .option('--category <key>', 'Only one registry category (e.g. "traffic_analytics").')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { scope?: string; category?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            // `--scope split-test` is the same request as `--scope split_test`;
            // every other flag on this command is hyphenated, so accept both
            // rather than 422 on a plausible spelling.
            const scope = opts.scope?.trim().replace(/-/g, '_');
            const catalog = await api.listAnalyticsCards(rt.config.brandId, { scope });

            let cards = catalog.cards;
            if (opts.category) {
                const needle = opts.category.toLowerCase();
                cards = cards.filter(card =>
                    card.category.toLowerCase().includes(needle)
                    || (card.category_name ?? '').toLowerCase().includes(needle));
            }

            if (opts.json) {
                log.json({
                    ok: true,
                    brand_id: rt.config.brandId,
                    scope: catalog.scope,
                    scopes: catalog.scopes,
                    count: cards.length,
                    cards,
                });
                return;
            }

            if (cards.length === 0) {
                log.info(opts.category
                    ? `No cards in a category matching "${opts.category}"${scope ? ` for scope "${scope}"` : ''}.`
                    : `No cards available${scope ? ` for scope "${scope}"` : ''}.`);
                if (catalog.scopes.length) log.detail(`Scopes: ${catalog.scopes.join(', ')}.`);
                return;
            }

            const byCategory = new Map<string, AnalyticsCard[]>();
            for (const card of cards) {
                const title = card.category_name ?? catalog.categories[card.category] ?? card.category;
                if (!byCategory.has(title)) byCategory.set(title, []);
                byCategory.get(title)!.push(card);
            }

            // With a scope asked for, every row carries the same one — the column
            // would be a wall of the word the user just typed.
            const showScopes = !scope;
            for (const [title, list] of [...byCategory].sort((a, b) => a[0].localeCompare(b[0]))) {
                log.info(`\n${c.bold(title)}`);
                const rows = list.map(card => showScopes
                    ? [card.key, card.name, card.scopes.join(', '), card.description ?? '']
                    : [card.key, card.name, card.description ?? '']);
                process.stdout.write(renderTable({
                    head: showScopes
                        ? ['KEY', 'NAME', 'RESOLVES IN', 'WHAT IT SHOWS']
                        : ['KEY', 'NAME', 'WHAT IT SHOWS'],
                    rows,
                    // 60 matches `ef stats metrics`, and is the width at which the
                    // full five-scope list ("brand, page, funnel, split_test,
                    // component_split_test", 53 chars) stops being truncated —
                    // that column is the whole point of the unscoped view.
                    maxCellWidth: 60,
                }) + '\n');
            }

            log.detail(`\n${cards.length} card(s)${scope ? ` for scope "${scope}"` : ''}.`
                + (showScopes && catalog.scopes.length ? ` Narrow with --scope: ${catalog.scopes.join(', ')}.` : ''));
        });

    // ── ef stats fields ──────────────────────────────────────────────
    cmd.command('fields')
        .description('List the dimensions "ef stats by <field>" can group on.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const cats = await api.listAnalyticsGroupingFields(rt.config.brandId);

            if (opts.json) { log.json({ ok: true, categories: cats }); return; }
            for (const [, cat] of Object.entries(cats)) {
                log.info(`\n${c.bold(cat.name)}`);
                const rows = Object.entries(cat.fields).map(([key, f]) => [key, f.name, f.description ?? '']);
                process.stdout.write(renderTable({ head: ['FIELD', 'NAME', 'DESCRIPTION'], rows, maxCellWidth: 60 }) + '\n');
            }
            log.detail('\nUse with: ef stats by <field>');
        });

    // ── ef stats by <field> ──────────────────────────────────────────
    const by = withCommonFlags(
        cmd.command('by <field>')
            .description('Break the metrics down by one dimension (page, product, country, day, …).'),
    );
    by
        .addHelpText('after', `
Examples:
  $ ef stats by page --metrics revenue,sessions
  $ ef stats by country --range 30d --limit 10
  $ ef stats by day --metrics revenue --range 14d
  $ ef stats by utm_source --sort revenue

"ef stats fields" lists every dimension this brand can group on.`)
        .option('--limit <n>', 'Max rows to print.', '20')
        .option('--sort <metric>', 'Sort rows by this metric, descending. Defaults to the first one.')
        .action(async (field: string, opts: RangeFlags & ScopeFlags & { metrics?: string; json?: boolean; limit?: string; sort?: string }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const q = buildQuery(rt, opts);
            const wanted = parseMetrics(opts.metrics, DEFAULT_METRICS);
            const limit = Number(opts.limit ?? 20);
            if (!Number.isInteger(limit) || limit < 1) {
                throw new CliError(ExitCode.Validation, `--limit takes a positive integer. Got "${opts.limit}".`);
            }

            let rows = await api.getAnalyticsGrouped(rt.config.brandId, field, { ...q, metrics: wanted });

            // A time series reads in time order; everything else reads biggest
            // first. Sorting days by value would print a chart nobody can follow.
            const sortBy = opts.sort ?? wanted[0];
            rows = opts.sort == null && TEMPORAL_FIELDS.has(field)
                ? rows.sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true }))
                : rows.sort((a, b) => (b.metrics[sortBy]?.value ?? 0) - (a.metrics[sortBy]?.value ?? 0));
            const shown = rows.slice(0, limit);

            if (opts.json) {
                log.json({
                    ok: true,
                    brand_id: rt.config.brandId,
                    field,
                    range: { start: q.start, end: q.end, tz: q.tz },
                    total_rows: rows.length,
                    rows: shown.map(r => ({
                        key: r.key,
                        label: r.label,
                        metrics: Object.fromEntries(wanted.filter(m => r.metrics[m]).map(m => [m, r.metrics[m].value])),
                    })),
                });
                return;
            }

            log.info(`${c.bold(`by ${field}`)}  ${rangeHeader(q.range)}`);
            if (shown.length === 0) {
                log.info('No data in this range.');
                return;
            }
            const cols = wanted.filter(m => shown.some(r => r.metrics[m] != null));
            const table = shown.map(r => [
                r.label,
                ...cols.map(m => String(r.metrics[m]?.formatted ?? r.metrics[m]?.value ?? '-')),
            ]);
            process.stdout.write(renderTable({ head: [field.toUpperCase(), ...cols.map(m => m.toUpperCase())], rows: table }) + '\n');
            if (rows.length > shown.length) {
                log.detail(`${shown.length} of ${rows.length} rows — raise --limit to see more.`);
            }
        });

    // ── ef stats splits ──────────────────────────────────────────────
    cmd.command('splits')
        .description('List this brand\'s split tests.')
        .option('--status <status>', 'Filter by status.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { status?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const tests = await api.listSplitTests(rt.config.brandId, opts.status ? { status: opts.status } : undefined);

            if (opts.json) { log.json({ ok: true, count: tests.length, split_tests: tests }); return; }
            if (tests.length === 0) {
                log.info('No split tests on this brand.');
                return;
            }
            const rows = tests.map(t => [
                String(t.id),
                t.name ?? '',
                t.type ?? '',
                String(t.status ?? ''),
                t.page?.title ?? t.funnel?.title ?? '',
                String(t.views ?? 0),
            ]);
            process.stdout.write(renderTable({ head: ['ID', 'NAME', 'TYPE', 'STATUS', 'TARGET', 'VIEWS'], rows }) + '\n');
            log.detail('Results for one: ef stats split <id>');
        });

    // ── ef stats split <id> ──────────────────────────────────────────
    const split = withCommonFlags(
        cmd.command('split <id>')
            .description('Results for one split test: per-variant metrics and the significance verdict.'),
    );
    split
        .addHelpText('after', `
Examples:
  $ ef stats split 321
  $ ef stats split 321 --metrics sessions,conversion_rate,revenue,aov
  $ ef stats split 321 --range 30d --json

The verdict is the server's own: alpha is corrected for the number of arms and
no winner is named until every arm clears the power-based sample floor. The CLI
reports that rather than running its own test, so it cannot disagree with the
dashboard about who won.`)
        .action(async (id: string, opts: RangeFlags & ScopeFlags & { metrics?: string; json?: boolean }) => {
            const splitTestId = numericFlag('id', id);
            if (splitTestId == null) throw new CliError(ExitCode.Validation, 'Pass a split test id.');

            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const q = buildQuery(rt, opts);
            const wanted = parseMetrics(opts.metrics, DEFAULT_SPLIT_METRICS);

            const [test, variants, significance] = await Promise.all([
                api.getSplitTest(rt.config.brandId, splitTestId),
                api.getSplitTestMetrics(rt.config.brandId, splitTestId, { ...q, metrics: wanted }),
                // A test too young to score still has per-variant numbers worth
                // showing, so a significance failure must not sink the command.
                api.getSplitTestSignificance(rt.config.brandId, splitTestId, q.start, q.end).catch(() => null),
            ]);

            if (opts.json) {
                log.json({
                    ok: true,
                    brand_id: rt.config.brandId,
                    split_test: { id: test.id, name: test.name, type: test.type, status: test.status },
                    range: { start: q.start, end: q.end, tz: q.tz },
                    variants: variants.map((v: AnalyticsGroupRow) => ({
                        variant: v.label,
                        metrics: Object.fromEntries(wanted.filter(m => v.metrics[m]).map(m => [m, v.metrics[m].value])),
                    })),
                    significance,
                });
                return;
            }

            log.info(`${c.bold(test.name ?? `Split test ${splitTestId}`)} ${c.dim(`(#${splitTestId}, ${q.start} → ${q.end}, ${q.tz})`)}`);
            if (variants.length === 0) {
                log.info('No variant data in this range.');
                return;
            }
            const cols = wanted.filter(m => variants.some(v => v.metrics[m] != null));
            const baseline = significance?.baseline ?? null;
            const rows = variants.map(v => [
                v.label + (v.label === baseline ? c.dim(' (control)') : ''),
                ...cols.map(m => String(v.metrics[m]?.formatted ?? v.metrics[m]?.value ?? '-')),
            ]);
            process.stdout.write(renderTable({ head: ['VARIANT', ...cols.map(m => m.toUpperCase())], rows }) + '\n');

            if (!significance) {
                log.detail('No significance verdict available for this range.');
                return;
            }
            log.info('');
            const p = significance.pvalue;
            log.info(`${c.bold('p-value')}  ${p != null ? p.toFixed(4) : '—'}   ${c.bold('power')} ${significance.power != null ? `${(significance.power * 100).toFixed(1)}%` : '—'}`);
            if (significance.winner) {
                log.success(`Winner: ${significance.winner}${significance.auto_stopped ? ' (auto-stopped)' : ''}`);
            } else if (significance.sample_size_for_significance != null) {
                log.detail(`No winner yet — each arm needs ~${significance.sample_size_for_significance} sessions before a call can be made.`);
            } else {
                log.detail('No winner yet — not enough data to score this test.');
            }
        });

    // ── ef stats dashboards ──────────────────────────────────────────
    cmd.command('dashboards')
        .description('List this brand\'s saved dashboards and the available presets.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const [saved, presets] = await Promise.all([
                api.listDashboards(rt.config.brandId),
                api.listDashboardPresets(rt.config.brandId),
            ]);

            if (opts.json) { log.json({ ok: true, dashboards: saved, presets }); return; }

            log.info(c.bold('Saved dashboards'));
            if (saved.length === 0) {
                log.detail('  none');
            } else {
                process.stdout.write(renderTable({
                    head: ['ID', 'NAME'],
                    rows: saved.map(d => [String(d.id), d.name ?? '']),
                }) + '\n');
            }
            log.info(`\n${c.bold('Presets')}`);
            process.stdout.write(renderTable({
                head: ['KEY', 'NAME', 'DESCRIPTION'],
                rows: presets.map(p => [p.key, p.name, p.description ?? '']),
                maxCellWidth: 60,
            }) + '\n');
        });
}
