/**
 * Brand-level settings for the three discovery files the page runtime serves
 * per host: sitemap.xml, llms.txt and robots.txt.
 *
 * All three are off until someone turns them on, and each one lists only the
 * pages individually opted in with `ef pages settings <slug> --sitemap`. A
 * brand's pages are mostly funnel steps, upsells and checkouts, so nothing here
 * publishes anything by default.
 */
export interface BrandSeoConfig {
    sitemap_enabled: boolean;
    llms_enabled: boolean;
    robots_enabled: boolean;
    /** llms.txt heading. Null/empty falls back to the brand name. */
    site_name?: string | null;
    /** What `site_name` resolves to at serve time, fallback already applied. */
    site_name_effective?: string | null;
    /** llms.txt summary blockquote. */
    site_summary?: string | null;
    /** Free markdown appended to the end of llms.txt. */
    llms_notes?: string | null;
    /** Extra directives appended to robots.txt (one per line). */
    robots_extra?: string | null;
}

/** A page that appears in this brand's discovery files. */
export interface SeoPage {
    id: number;
    title: string | null;
    slug: string | null;
    /**
     * The path actually emitted. An index page answers on `/` as well as on its
     * own slug and is advertised as `/`, so this is not always `/<slug>`.
     */
    path: string;
    /** The domain the page is attached to; null means every brand domain. */
    domain: string | null;
    description: string | null;
    /** Whether this page actually appears in the files right now. */
    listed: boolean;
    /**
     * Why it does not appear, when `listed` is false. A page can be opted in
     * and still be excluded — a draft, a checkout, a noindex page or a
     * `{param}` route slug all tick the box to no effect — so the reason is
     * reported rather than the row being silently dropped.
     */
    excluded_reason: SeoExclusionReason | null;
    updated_at?: string | null;
}

export type SeoExclusionReason =
    | 'pattern_slug'
    | 'prevent_indexing'
    | 'not_published'
    | 'funnel_only'
    | 'requires_login'
    | 'requires_password'
    | 'upsell_page'
    | 'checkout_page';

/** Why a page is excluded, in words — used by `ef seo pages` and `ef seo status`. */
export const SEO_EXCLUSION_REASON: Record<SeoExclusionReason, string> = {
    pattern_slug: 'slug is a {param} route pattern — it stands for many URLs, not one',
    prevent_indexing: 'page is set to prevent search engine indexing',
    not_published: 'page is not published',
    funnel_only: 'page is only visible through a funnel',
    requires_login: 'page requires login',
    requires_password: 'page requires a password',
    upsell_page: 'page is an upsell page',
    checkout_page: 'page is a checkout page',
};
