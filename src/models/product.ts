export interface ProductVariant {
    id?: number;
    code?: string | null;
    price?: number | null;
    retail_price?: number | null;
    sku?: string | null;
    units?: number | null;
    [k: string]: unknown;
}

/**
 * One bonus attached to a main product (`brand_product_bonuses` row). A bonus
 * is a FREE product the buyer receives (or picks) with the main product; it is
 * never a bump. Older servers return only `bonus_product_id`.
 */
export interface ProductBonus {
    product_id?: number | null;
    bonus_product_id?: number | null;
    code?: string | null;
    title?: string | null;
    type?: string | null;
    position?: number | null;
    quantity?: number | null;
    giftable?: boolean | null;
    [k: string]: unknown;
}

/**
 * Pick rule for a main product's bonuses (`brand_product_bonus_rules`). No rule
 * means legacy behaviour: every bonus included, no picking, no gift — and the
 * internal checkout does not activate pivot bonuses at all without a rule or a
 * page/funnel override.
 */
export interface BonusRule {
    min_picks: number | null;
    /** null = all bonuses. */
    max_picks: number | null;
    default_mode: 'first_n' | 'all';
    gift_shipping_enabled: boolean;
    gift_shipping_mode: 'same_as_main' | 'free' | 'fixed';
    gift_shipping_price: number | null;
}

/**
 * Brand product. The API exposes far more fields than this (warehousing,
 * fulfillment, COGS, product files, …); we keep the common ones typed and
 * leave the rest open so the CLI can round-trip a full payload via --file
 * without dropping anything.
 */
export interface Product {
    id: number;
    title: string | null;
    code: string | null;
    checkout_title?: string | null;
    description?: string | null;
    short_description?: string | null;
    status?: 'draft' | 'active' | 'archived' | string | null;
    type?: 'physical' | 'digital' | 'service' | string | null;
    classification?: 'main' | 'upsell' | 'downsell' | 'bump' | 'bonus' | string | null;
    price?: number | null;
    retail_price?: number | null;
    currency?: string | null;
    sku?: string | null;
    units?: number | null;
    image?: string | null;
    gallery?: string[] | null;
    seo_title?: string | null;
    seo_description?: string | null;
    seo_slug?: string | null;
    variants?: ProductVariant[];
    bonuses?: ProductBonus[];
    bonus_rule?: BonusRule | null;
    updated_at?: string | null;
    created_at?: string | null;
    [k: string]: unknown;
}
