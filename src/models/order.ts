/**
 * One row of `GET /api/brands/{brand}/conversions` (ConversionsController@index).
 *
 * The list is Elasticsearch-backed and returns whatever columns the document
 * carries, so every field is optional. Only the ones the CLI reads are typed;
 * the rest ride along under the index signature and reach `--json` untouched
 * (minus PII — see `utils/orders.ts#stripPii`).
 */
export interface ConversionRow {
    code?: string;
    type?: string;
    total?: number | string | null;
    currency_code?: string | null;
    purchased_at?: string | null;
    created_at?: string | null;
    session_id?: string | null;
    click_code?: string | null;
    /** Funnel id — `funnel_id` on legacy docs, `fid` on standardized ones. */
    funnel_id?: number | null;
    fid?: number | null;
    /** Page id — `page_id` on legacy docs, `pgid` on standardized ones. */
    page_id?: number | null;
    pgid?: number | null;
    /** Merchant-side affiliate id (what `filter[aff_id]` matches). */
    aff_id?: string | number | null;
    aff_source?: string | null;
    merchant_affiliate_name?: string | null;
    product_codes_v?: string[] | null;
    product_codes?: string[] | string | null;
    customer_email?: string | null;
    is_test?: boolean;
    page?: { id?: number; title?: string | null; slug?: string | null } | null;
    funnel?: { id?: number; title?: string | null } | null;
    products?: Array<{ product_id?: number; name?: string | null; product?: { code?: string | null; title?: string | null } | null }> | null;
    [key: string]: unknown;
}

/** Laravel-style paginated envelope the ES list endpoints return. */
export interface Paginated<T> {
    total: number;
    last_page: number;
    current_page: number;
    per_page: number;
    data: T[];
    next_page_url?: string | false | null;
    error?: string;
}

/**
 * One row of `GET /api/brands/{brand}/clicks` (ClicksController@index). A click
 * is one page load; a session is one or more of them.
 */
export interface ClickRow {
    click_code?: string;
    session_id?: string | null;
    created_at?: string | null;
    url?: string | null;
    referrer?: string | null;
    user_agent?: string | null;
    aff_id?: string | number | null;
    funnel_id?: number | null;
    domain_id?: number | null;
    d_country_code?: string | null;
    d_device_type?: string | null;
    d_is_bot?: boolean | null;
    d_is_hosting?: boolean | null;
    events?: SessionEvent[] | null;
    funnel?: { id?: number; title?: string | null } | null;
    domain?: { id?: number; domain?: string | null } | null;
    [key: string]: unknown;
}

/** One tracked event inside a session (brand_events document). */
export interface SessionEvent {
    _id?: string;
    event?: string;
    created_at?: string;
    page_id?: number | null;
    funnel_id?: number | null;
    url?: string | null;
    href?: string | null;
    product_codes?: string[] | null;
    aff_id?: string | number | null;
    is_bot?: boolean | null;
    is_hosting?: boolean | null;
    d_is_bot?: boolean | null;
    d_is_hosting?: boolean | null;
    [key: string]: unknown;
}

/** `GET /api/brands/{brand}/clicks/session/{id}` (ClicksController@sessionDetails). */
export interface SessionDetails {
    geoData: {
        city?: string | null;
        region?: string | null;
        country?: string | null;
        [key: string]: unknown;
    } | unknown[];
    events: SessionEvent[];
    domains?: Record<string, string>;
    visit?: {
        click_code?: string | null;
        created_at?: string | null;
        url?: string | null;
        referrer?: string | null;
        user_agent?: string | null;
        funnel_id?: number | null;
        domain_id?: number | null;
        d_browser?: string | null;
        d_os?: string | null;
        d_device_type?: string | null;
        d_is_bot?: boolean | null;
        d_is_hosting?: boolean | null;
        d_is_vpn?: boolean | null;
        d_is_proxy?: boolean | null;
        d_is_tor?: boolean | null;
        click_count?: number;
        [key: string]: unknown;
    } | null;
    traffic_source?: { group?: string | null; key?: string | null; label?: string | null } | null;
}
