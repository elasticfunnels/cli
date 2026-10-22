/** A brand funnel. The editable graph is `config` (Drawflow), pulled/pushed via
 *  the /builder endpoint; `flow`/`product_flow`/`variant_seeds` are read-only
 *  artifacts the server regenerates on every save. */
export interface Funnel {
    id: number;
    brand_id?: number;
    code?: string | null;
    title?: string | null;
    status?: string | null;
    is_default?: boolean;
    starting_page_id?: number | null;
    checkout_page_id?: number | null;
    updated_at?: string;
    created_at?: string;
}

/** One domain assignment as `GET funnels/{id}` returns it (BrandFunnelDomain::json). */
export interface FunnelDomainAssignment {
    id?: number;
    domain_id: number;
    funnel_id?: number;
    is_default?: boolean | number | null;
    cb_funnel_id?: string | number | null;
    cb_template_code?: string | null;
    ds24_template_id?: string | number | null;
    jvz_funnel_id?: string | number | null;
}

/** `GET funnels/{id}?flow=0` (BrandFunnel::json): settings, without the compiled flow. */
export interface FunnelDetails extends Funnel {
    rules?: { match?: string; conditions?: unknown[] } | null;
    domains?: FunnelDomainAssignment[];
    domain?: { id?: number; domain?: string | null } | null;
    trigger_pages?: number[];
}

/** A page the runtime's funnel trace says a step leads to (FunnelTriggerController::summariseTrace). */
export interface FunnelResolveDestination {
    kind?: string;
    page_id?: number | null;
    title?: string | null;
    slug?: string | null;
    status?: string | null;
    url?: string | null;
    arms?: number | null;
}

/** One row of the runtime resolver's trace: a step, its outcome, and the funnel it was about. */
export interface FunnelResolveTraceRow {
    step?: string;
    outcome?: string;
    reason?: string;
    funnel_id?: number | null;
    funnel_code?: string | null;
    conditions?: Array<{ field?: string; operator?: string; value?: unknown; group?: unknown }>;
}

/**
 * `POST funnels/resolve-test` (FunnelTriggerController@resolveTest): the page runtime's verdict
 * plus `funnel_titles`. `resolved: false` means the runtime could not answer (no page at that
 * path, or no funnel response), which is different from "no funnel would run" (`winner: null`).
 */
export interface FunnelResolveResult {
    ok?: boolean;
    resolved?: boolean;
    reason?: string;
    host?: string;
    path?: string;
    domain?: { id?: number; domain?: string | null } | null;
    page?: { id?: number; title?: string | null; slug?: string | null } | null;
    context?: { affiliate?: string | number | null; query?: Record<string, unknown> } | null;
    explicit_funnel_param?: string | null;
    session_funnel_code?: string | null;
    winner?: { id?: number; code?: string | null; title?: string | null } | null;
    won_via?: string | null;
    trace?: FunnelResolveTraceRow[];
    assignments?: unknown[];
    funnel_titles?: Record<string, string>;
    next?: {
        merchant?: { id?: number | null; name?: string | null; gateway?: string | null; from_events?: boolean } | null;
        redirects_to?: string | null;
        checkout?: boolean;
        after_buy?: Array<{ products?: Array<{ code?: string; name?: string | null; price?: unknown }>; to?: FunnelResolveDestination | null }>;
        after_decline?: FunnelResolveDestination | null;
    };
}
