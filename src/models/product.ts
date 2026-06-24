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
    updated_at?: string | null;
    created_at?: string | null;
    [k: string]: unknown;
}
