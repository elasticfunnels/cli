export interface Brand {
    id: number;
    name: string;
    slug?: string | null;
    domain?: string | null;
    timezone?: string | null;
    organization_id?: number | null;
}
