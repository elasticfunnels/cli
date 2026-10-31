export interface Component {
    id: number;
    name: string;
    code?: string | null;
    html?: string | null;
    type?: string | null;
    revision_id?: number | null;
    updated_at?: string | null;
    /** Multilingual sites: the component's language; null = the base component every language falls back to. */
    language?: string | null;
    /** The component this one translates. */
    translation_source_id?: number | null;
    translation_stale?: boolean | null;
    translation_source_hash?: string | null;
}
