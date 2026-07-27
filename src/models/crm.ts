// CRM DTOs. Definitions (entity/pipeline/stage/field) live in MySQL; entries
// live in Elasticsearch, so an entry `id` is a string document id.

export interface CrmEntity {
    id: number;
    brand_id?: number;
    name?: string;
    slug?: string;
    singular_name?: string;
    plural_name?: string;
    icon?: string | null;
    color?: string | null;
    entity_mode?: 'crm' | 'data' | string;
    is_system?: boolean;
}

export interface CrmStage {
    id: number;
    pipeline_id?: number;
    name?: string;
    slug?: string;
    color?: string | null;
    order?: number;
    probability?: number;
    semantic_status?: string | null;
}

export interface CrmPipeline {
    id: number;
    crm_entity_id?: number;
    name?: string;
    slug?: string;
    purpose?: string | null;
    is_default?: boolean;
    stages?: CrmStage[];
}

export interface CrmField {
    id: number;
    crm_entity_id?: number;
    label?: string;
    key?: string;
    type?: string;
    options?: unknown;
}

export interface CrmEntry {
    id: string;
    crm_entity_id?: number;
    pipeline_id?: number;
    stage_id?: number;
    title?: string;
    values?: Record<string, unknown>;
    reference_type?: string | null;
    reference_id?: string | null;
    assigned_to_user_id?: number | null;
    updated_at?: string;
}
