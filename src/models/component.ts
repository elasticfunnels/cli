export interface Component {
    id: number;
    name: string;
    code?: string | null;
    html?: string | null;
    type?: string | null;
    revision_id?: number | null;
    updated_at?: string | null;
}
