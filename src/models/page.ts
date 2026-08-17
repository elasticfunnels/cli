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
    updated_at?: string | null;
    created_at?: string | null;
}

export interface PageUpdateResponse {
    success: boolean;
    revision_id?: number | null;
    preview_url?: string | null;
    collections_created?: Array<{ code: string; id: number; name?: string }>;
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
