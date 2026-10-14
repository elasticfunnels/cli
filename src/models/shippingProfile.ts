/** One per-country rate on a shipping profile. */
export interface ShippingOverride {
    country_code: string;
    cost: number | string;
}

/**
 * A brand shipping profile (Products → Shipping Profiles). At checkout the buyer's
 * country picks ONE rate: a matching override, else `us_mainland` for US, else
 * `international`. An empty rate is free shipping for that region, never a
 * fallback to the other one.
 */
export interface ShippingProfile {
    id: number;
    name: string;
    description?: string | null;
    shipping_costs?: {
        us_mainland?: number | string | null;
        international?: number | string | null;
        overrides?: ShippingOverride[];
    } | null;
    is_default?: boolean;
    allow_select_on_checkout?: boolean;
    products_count?: number;
}
