/**
 * A brand collection — the store behind a lead-capture `<form>`.
 *
 * Forms on a page are wired to a collection by its `code`, which the server
 * generates. That code is the thing you actually need in markup, which is why
 * the CLI surfaces collections at all: without it, the only way to obtain a
 * code was to push a form and read back what the server rewrote.
 */
export interface BrandCollection {
    id: number;
    name: string;
    /** Stable slug used in `action="/api/collection/<code>/store"`. Server-generated. */
    code: string;
    total_entries?: number;
    public_export?: boolean | number;
    on_new_entry?: string | null;
    send_to_email?: string | null;
    fields?: BrandCollectionField[];
    created_at?: string;
    updated_at?: string;
}

/** Field types the server accepts. Anything else is rejected by validation. */
export const COLLECTION_FIELD_TYPES = [
    'text', 'email', 'number', 'checkbox', 'password', 'textarea', 'select', 'hidden',
] as const;

export type CollectionFieldType = typeof COLLECTION_FIELD_TYPES[number];

export interface BrandCollectionField {
    id?: number;
    name: string;
    type: CollectionFieldType | string;
    /** Key used in submitted form data. Server derives it from `name` when omitted. */
    key?: string;
    placeholder?: string | null;
    required?: boolean;
    searchable?: boolean;
    private?: boolean;
    options?: string[] | null;
    default_value?: string | null;
    order?: number;
}
