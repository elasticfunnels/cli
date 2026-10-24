/**
 * Contacts (one record per person: leads and buyers), as served by
 * `GET /api/brands/{brand}/contacts` and `GET /api/brands/{brand}/contacts/{public_id}`.
 *
 * The server masks emails, phones, names and postal codes (`p***@e***.com`)
 * unless the credential's user holds the `contacts.view_pii` permission;
 * `can_view_pii` says which you got.
 */
export interface ContactRow {
    public_id: string;
    lifecycle: 'customer' | 'lead' | string;
    email_status?: string | null;
    sms_status?: string | null;
    tags?: string[];
    customer_email?: string | null;
    customer_name?: string | null;
    customer_first_name?: string | null;
    customer_last_name?: string | null;
    customer_phone?: string | null;
    customer_country?: string | null;
    customer_state?: string | null;
    customer_city?: string | null;
    customer_postal_code?: string | null;
    total_orders?: number;
    total_revenue?: number;
    lifetime_value?: number;
    last_order_date?: string | null;
    first_order_date?: string | null;
    created_at?: string | null;
    [key: string]: unknown;
}

export interface ContactListPage {
    total: number;
    last_page: number;
    current_page: number;
    per_page: number;
    data: ContactRow[];
    can_view_pii: boolean;
}

export interface ContactDetail {
    public_id: string;
    lifecycle: string;
    email?: string | null;
    phone?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    postal_code?: string | null;
    country?: string | null;
    email_status?: string | null;
    sms_status?: string | null;
    orders_count?: number;
    purchases_total?: number;
    currency_code?: string | null;
    tags?: string[];
    emails?: { email: string | null; is_primary: boolean; source?: string | null }[];
    phones?: { phone: string | null; is_primary: boolean; source?: string | null }[];
    consent?: { channel: string; address: string | null; status: string; source?: string | null; occurred_at?: string | null }[];
    merges?: unknown[];
    can_view_pii: boolean;
    [key: string]: unknown;
}
