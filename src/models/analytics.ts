/**
 * Analytics DTOs — the brand's own numbers, as `ef stats` reads them.
 *
 * Everything here comes off the same `/api/brands/{brand}/analytics/*` surface
 * the app's dashboard uses, through the same `brandAccess` middleware as the
 * rest of the CLI. That has one consequence worth stating: a project's
 * `.ef/auth` key is scoped to its brand, so `ef stats` reports on the brand the
 * folder is bound to and returns 401 for any other. There is no account-wide
 * roll-up, by construction.
 */

/** One metric in the registry, as `GET analytics/metrics` lists it. */
export interface AnalyticsMetricDef {
    /** Registry key — what you pass to `--metrics`. */
    type: string;
    /** Human label ("Net Revenue"). */
    name: string;
    /** Chart colour the app uses. Kept so `--json` consumers can match it. */
    color?: string | null;
    /** One-line description of what the number counts. */
    info?: string | null;
    /** Registry grouping ("Revenue & Sales", "Advertising Metrics", …). */
    group_name?: string;
}

/**
 * A single metric's value for a date range.
 *
 * The server always computes the comparison window too, which is why every
 * field here has a `previous_*` twin. `formatted_value` is the server's own
 * rendering (currency symbol, percent sign, thousands separators) — we print
 * that rather than re-deriving it, so the CLI and the dashboard never disagree
 * about what "$1,234.50" looks like.
 */
export interface AnalyticsMetricValue {
    value: number;
    previous_value?: number | null;
    formatted_value?: string | null;
    /** Absolute delta, pre-formatted ("$1,589.74"). */
    change?: string | null;
    /** "+" / "-" / "" — the direction of `change`. */
    change_symbol?: string | null;
    change_percent?: number | null;
    /** What the comparison window was ("vs yesterday", "vs previous month"). */
    previous_range_label?: string | null;
    /**
     * Whether a rise is good. Cost metrics set this, so a caller colouring the
     * delta green/red does not paint a 40% jump in commissions as a win.
     */
    lower_is_better?: boolean;
    /** Set when the metric has no good/bad direction at all (counts, ratios). */
    neutral?: boolean;
    info?: string | null;
    current_range?: { start: string; end: string };
}

/** `GET analytics/metrics/data` — keyed by metric type. */
export type AnalyticsMetricData = Record<string, AnalyticsMetricValue>;

/**
 * One row of a grouped breakdown (`GET analytics/metrics/{field}/data`).
 *
 * The endpoint returns an object keyed by a display string ("Index (8879)"),
 * with the id and label repeated inside the row. We normalise to a list on the
 * way through, because the key is a presentation detail and sorting a JS object
 * by insertion order is not something to build a report on.
 */
export interface AnalyticsGroupRow {
    /** The grouped entity's id (page id, product id, country code, …). */
    key: string | number;
    /** Display label ("Index", "United States", "2026-08-18"). */
    label: string;
    /** Metric type → value, for the metrics that were requested. */
    metrics: Record<string, { value: number; formatted?: string | number | null }>;
}

/**
 * One card in the analytics catalog (`GET analytics/cards`).
 *
 * A card is a dashboard tile — "Top Products", "Revenue by Country" — and the
 * catalog is the server's answer to which ones exist for this brand. Like the
 * metric registry it is discovered, never hardcoded: the definitions live in the
 * app's own card registry and the endpoint has already dropped the ones this
 * brand's integrations or this key's role cannot reach.
 */
export interface AnalyticsCard {
    /** Card id ("top_products_by_pages"). */
    key: string;
    /** Human label ("Top Performing Products by Pages"). */
    name: string;
    /** One line on what the card shows. */
    description?: string | null;
    /** Registry category key ("product_analytics"). */
    category: string;
    /** That category's title ("Products"). */
    category_name?: string;
    /**
     * The report scopes this card can RESOLVE in — where its number means what
     * its heading says. A card missing `page` is not merely unstyled on a page
     * report: its data source ignores the page filter, so it would answer with
     * the brand's figure under the page's heading.
     */
    scopes: string[];
    /** Integration the card needs, when it needs one ("reconciliation"). */
    requires_integration?: string | null;
    /** Grid width the dashboard gives it, out of 12. */
    width?: number | null;
}

/** `GET analytics/cards` — the catalog, plus the vocabulary to read it with. */
export interface AnalyticsCardCatalog {
    cards: AnalyticsCard[];
    /** Category key → title, for the categories still present after filtering. */
    categories: Record<string, string>;
    /** Every scope name the server accepts. Its list, not ours. */
    scopes: string[];
    /** The scope that was asked for, or null for the whole catalog. */
    scope: string | null;
}

/** A split test, as the list endpoint returns it. */
export interface SplitTest {
    id: number;
    name: string;
    /** 'page' | 'funnel' | 'component' — what is being varied. */
    type?: string | null;
    status?: string | number | null;
    views?: number | null;
    page_id?: number | null;
    funnel_id?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    duration?: number | null;
    auto_select_winner?: boolean | number | null;
    baseline?: string | null;
    created_at?: string | null;
    page?: { id: number; title?: string | null; slug?: string | null } | null;
    funnel?: { id: number; title?: string | null; code?: string | null } | null;
}

/** One arm of a split test, as the significance endpoint scores it. */
export interface SplitTestVariant {
    variant: string;
    sample_size: number;
    conversions: number;
    conv_rate: number;
    /** p-value of this arm against the baseline. Null for the baseline itself. */
    pvalue?: number | null;
    z_score?: number | null;
    /** Relative lift over the baseline, as a fraction. */
    lift?: number | null;
}

/**
 * `GET split-tests/{id}/significance` — the server's own statistics.
 *
 * Deliberately read rather than recomputed. The backend applies a
 * multiple-comparison correction to alpha and refuses to name a winner until
 * both arms clear the power-based minimum sample size; a CLI that did its own
 * two-proportion test would quietly disagree with the dashboard about who won.
 */
export interface SplitTestSignificance {
    variants: SplitTestVariant[];
    /** Which arm is the control. */
    baseline: string | null;
    significance_level: number;
    /** Alpha after the multiple-comparison correction. */
    corrected_alpha?: number | null;
    pvalue?: number | null;
    z_score?: number | null;
    power?: number | null;
    /** Sample size per arm needed before a call can be made. */
    sample_size_for_significance?: number | null;
    /** Non-null only when a challenger won *and* cleared the sample floor. */
    winner: string | null;
    auto_stopped?: boolean;
}

/** A preset dashboard (`GET dashboards/presets`). */
export interface DashboardPreset {
    key: string;
    name: string;
    description?: string | null;
    layout?: unknown;
}

/** A saved custom dashboard (`GET dashboards`). */
export interface DashboardConfig {
    id: number;
    name: string;
    description?: string | null;
    updated_at?: string | null;
}
