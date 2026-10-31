export interface Page {
    id: number;
    title: string | null;
    slug: string | null;
    variant_slug?: string | null;
    status?: string | null;
    domain?: string | null;
    folder_id?: number | null;
    parent_page_id?: number | null;
    version_index?: number | null;
    is_active_version?: boolean;
    html?: string | null;
    revision_id?: number | null;
    /** Requires Login (members-only) and where a visitor without a customer session is sent. */
    requires_login?: boolean | number | null;
    redirect_url?: string | null;
    updated_at?: string | null;
    created_at?: string | null;
    seo_title?: string | null;
    seo_description?: string | null;
    page_type?: string | null;
    /** Multilingual sites: the page's language (normalized code, "pt-br"); null = not set. */
    language?: string | null;
    /** The page this one translates; null on the source page and on pages outside a group. */
    translation_source_id?: number | null;
    /** translation_source_id ?? id, computed by the server. */
    translation_group_id?: number | null;
    /** True when the source changed since this translation was made or marked synced; null on a source. */
    translation_stale?: boolean | null;
    /** Hash of the source's text when this translation was made or last marked synced. */
    translation_source_hash?: string | null;
}

export interface PageUpdateResponse {
    success: boolean;
    revision_id?: number | null;
    preview_url?: string | null;
    collections_created?: Array<{ code: string; id: number; name?: string }>;
    /** Tracking snippets this save added to the page (keys from the app's TrackingCodeInPage). */
    tracking_code_in_page?: string[];
    /** Link warnings for the saved page (the app's page list triangle). */
    link_warnings?: import('../sync/linkWarnings').PageLinkWarning[];
    /** Present on HTTP 409 from /editor — the server's idea of the current state. */
    code?: string;
    server_revision_id?: number | null;
    /** Laravel page/component editors return this field on 409. */
    latest_revision_id?: number | null;
    server_html?: string | null;
}

/**
 * One member of a page's variant family (whole-page split tests).
 *
 * The family's parent is the row with `parent_page_id === null` (`is_parent`);
 * every other row is a sibling variant distinguished by `variant_slug`, with
 * exactly one carrying `is_active_version`.
 */
export interface PageVariant {
    id: number;
    title: string | null;
    slug: string | null;
    variant_slug: string | null;
    page_type?: string | null;
    status?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    /** True for the family's parent (the row with `parent_page_id === null`). */
    is_parent: boolean;
    version_index: number | null;
    is_active_version: boolean;
    override_page_events?: boolean | null;
    url?: string | null;
}
