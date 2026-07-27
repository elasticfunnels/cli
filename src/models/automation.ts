/** A brand automation (triggered flow). The CLI only reads/creates the shell;
 *  the node/edge graph (builder_config) is authored in the automation builder. */
export interface Automation {
    id: number;
    title: string;
    status?: string;
    /** Canonical trigger identifier, e.g. "triggers_on_new_purchase". */
    trigger_node_type?: string | null;
    postback_code?: string | null;
    collection_code?: string | null;
    version?: number;
    created_at?: string;
    updated_at?: string;
}
