export interface BrandTemplate {
    id: number;
    name: string;
    slug: string;
    edit_mode?: 'builder' | 'editor' | string;
    updated_at?: string | null;
}

export interface BrandTemplatePage {
    id: number;
    template_id: number;
    page_slug: string;
    title?: string | null;
    updated_at?: string | null;
}
