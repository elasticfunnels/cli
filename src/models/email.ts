/** A brand email template (`brand_emails`). The HTML body is written through a
 *  separate `/builder` endpoint; metadata (subject, from, …) via plain update. */
export interface BrandEmail {
    id: number;
    brand_id?: number;
    code?: string | null;
    name?: string | null;
    subject?: string | null;
    preview_text?: string | null;
    from_name?: string | null;
    from_email?: string | null;
    reply_to_email?: string | null;
    variable_scope?: string | null;
    category?: string | null;
    is_system?: boolean;
    automation_id?: number | null;
    html?: string | null;
    css?: string | null;
    /** GrapesJS builder graph — opaque; the CLI preserves it verbatim. */
    config?: unknown;
    inline?: unknown;
    screenshot?: string | null;
    created_at?: string;
    updated_at?: string;
}
