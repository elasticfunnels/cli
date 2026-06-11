export interface BackendScript {
    id: number;
    code: string;
    name: string;
    description?: string | null;
    content?: string | null;
    status?: 'active' | 'inactive' | string;
    revision_id?: number | null;
    updated_at?: string | null;
}
