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
