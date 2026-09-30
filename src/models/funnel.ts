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
