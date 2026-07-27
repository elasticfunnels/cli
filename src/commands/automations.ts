import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatRelative, renderTable } from '../utils/format';

/**
 * `ef automations` — PREPARED, not yet fully functional.
 *
 * What works today: listing automations, printing the exact trigger + node-type
 * identifiers the app accepts, and creating an (empty) automation shell on the
 * server. What is NOT done yet: compiling a full node/edge graph and publishing
 * it live — that is finished in the ElasticFunnels automation builder. `create`
 * validates the intended trigger + steps against the real catalog so a build
 * spec fails fast on a bad identifier, then guides you into the builder.
 */

interface TriggerDef {
    /** Canonical identifier stored as trigger_node_type. */
    id: string;
    /** Short alias accepted on the CLI (e.g. new_purchase). */
    short: string;
    label: string;
    /** Extra accepted spellings (legacy names), already stripped of on_/triggers_. */
    aliases?: string[];
}

// Source of truth: Modules/Automations resources/js/catalog/Triggers/On.js.
const TRIGGERS: TriggerDef[] = [
    { id: 'triggers_on_new_purchase', short: 'new_purchase', label: 'On New Purchase' },
    { id: 'triggers_on_new_customer', short: 'new_customer', label: 'On New Customer' },
    { id: 'triggers_on_abandon', short: 'abandon', label: 'On Abandoned Cart', aliases: ['abandoned_cart', 'abandoned'] },
    { id: 'triggers_on_refund', short: 'refund', label: 'On Refund' },
    { id: 'triggers_on_chargeback', short: 'chargeback', label: 'On Chargeback' },
    { id: 'triggers_on_postback', short: 'postback', label: 'On Postback' },
    { id: 'triggers_on_clickbank_postback', short: 'clickbank_postback', label: 'On Clickbank Postback' },
    { id: 'triggers_on_new_collection_entry', short: 'new_collection_entry', label: 'On Collection Entry', aliases: ['collection_entry'] },
    { id: 'triggers_on_customer_automation', short: 'customer_automation', label: 'On Page Event Customer Automation' },
];

/** Map every accepted spelling → canonical id (after stripping triggers_/on_). */
function buildTriggerLookup(): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of TRIGGERS) {
        m.set(t.short, t.id);
        for (const a of t.aliases ?? []) m.set(a, t.id);
    }
    return m;
}
const TRIGGER_LOOKUP = buildTriggerLookup();

/** Normalize a user trigger string to the canonical id, or null if unknown. */
function normalizeTrigger(input: string): string | null {
    const stripped = input.trim().toLowerCase().replace(/^triggers_/, '').replace(/^on_/, '');
    return TRIGGER_LOOKUP.get(stripped) ?? null;
}

interface StepDef {
    render: 'trigger' | 'action' | 'condition' | 'wait' | 'splittest' | 'script';
    /** Canonical ef_type (or a template when the provider is chosen in the builder). */
    ef: string;
    note: string;
}

// Friendly step aliases → canonical node types (catalog: Modules/Automations/resources/js/catalog).
const STEP_ALIASES: Record<string, StepDef> = {
    email: { render: 'action', ef: 'mailing_<provider>_send_email', note: 'send an email (pick provider + email in the builder)' },
    sms: { render: 'action', ef: 'communications_twilio_send_sms', note: 'send an SMS (Twilio)' },
    wait: { render: 'wait', ef: 'control_general_wait_for', note: 'relative delay (minutes → 90 days)' },
    delay: { render: 'wait', ef: 'control_general_wait_for', note: 'relative delay (minutes → 90 days)' },
    until: { render: 'wait', ef: 'control_general_wait_until', note: 'wait until an absolute datetime' },
    condition: { render: 'condition', ef: 'control_general_continue_if', note: 'if/else branch (yes / no outputs)' },
    if: { render: 'condition', ef: 'control_general_continue_if', note: 'if/else branch (yes / no outputs)' },
    script: { render: 'script', ef: 'control_general_script', note: 'JS truthy/falsy branch' },
    splittest: { render: 'splittest', ef: 'control_general_split_test', note: 'weighted A/B split' },
    split: { render: 'splittest', ef: 'control_general_split_test', note: 'weighted A/B split' },
    webhook: { render: 'action', ef: 'communications_webhooks_http_request', note: 'HTTP request / webhook' },
    http: { render: 'action', ef: 'communications_webhooks_http_request', note: 'HTTP request / webhook' },
    tag: { render: 'action', ef: 'mailing_<provider>_add_contact_tags', note: 'add a contact tag (provider-specific)' },
};

/** Vue Flow render types (the six node shapes). */
const RENDER_TYPES = ['trigger', 'action', 'condition', 'wait', 'splittest', 'script'];

/** Representative node types per category (the catalog has many more per provider). */
const NODE_CATEGORIES: { category: string; examples: string[] }[] = [
    { category: 'Control', examples: ['control_general_continue_if', 'control_general_script', 'control_general_split_test', 'control_general_wait_for', 'control_general_wait_until', 'control_general_round_robin'] },
    { category: 'Mailing', examples: ['mailing_sendgrid_send_email', 'mailing_mailgun_send_email', 'mailing_mailchimp_add_contact_tags', 'mailing_activecampaign_create_or_update_contact', 'mailing_klaviyo_subscribe_to_list'] },
    { category: 'Communications', examples: ['communications_twilio_send_sms', 'communications_webhooks_http_request', 'communications_slack_send_message', 'communications_discord_send_message'] },
    { category: 'CRM', examples: ['crm_hubspot_create_or_update_contact', 'crm_keap_apply_tags', 'crm_pipedrive_create_deal', 'crm_ontraport_add_tag'] },
    { category: 'Storage', examples: ['storage_googlesheets_append_row', 'storage_googlesheets_find_and_update_row'] },
    { category: 'Orders', examples: ['orders_fulfil_create_sales_order', 'orders_shipoffers_create_order'] },
    { category: 'Validation', examples: ['validation_zerobounce_validate_email', 'validation_debounce_validate_email'] },
];

interface StepPlan { raw: string; name: string; arg?: string; def: StepDef; }

// ── Vue Flow graph construction ───────────────────────────────────────

interface FlowNode { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown>; }
interface FlowEdge { id: string; source: string; target: string; sourceHandle: string | null; targetHandle: string | null; }
interface BuilderConfig { nodes: FlowNode[]; edges: FlowEdge[]; viewport: { x: number; y: number; zoom: number }; }

/** Parse a wait argument (e.g. 4d, 5m, 2h, 1w) into minutes for wait_for. */
function parseWaitMinutes(arg?: string): number {
    if (!arg) return 0;
    const m = /^(\d+)\s*(mins?|m|hours?|hrs?|h|days?|d|weeks?|w)?$/i.exec(arg.trim());
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    const unit = (m[2] ?? 'm').toLowerCase();
    if (unit.startsWith('h')) return n * 60;
    if (unit.startsWith('d')) return n * 60 * 24;
    if (unit.startsWith('w')) return n * 60 * 24 * 7;
    return n; // minutes
}

const CATEGORY_BY_PREFIX: Record<string, string> = {
    control: 'Control', mailing: 'Mailing', communications: 'Communications',
    crm: 'CRM', storage: 'Storage', orders: 'Orders', validation: 'Validation',
    formatting: 'Formatting', triggers: 'Triggers',
};

function categoryFor(ef: string): string {
    return CATEGORY_BY_PREFIX[ef.split('_')[0]] ?? 'Action';
}

/** Per-node `values` stub for a step (finished in the builder for provider nodes). */
function nodeValues(plan: StepPlan): Record<string, unknown> {
    switch (plan.def.render) {
        case 'wait':
            return plan.def.ef === 'control_general_wait_until'
                ? { until: plan.arg ?? '', timezone: '', max_wait_minutes: 0 }
                : { minutes: parseWaitMinutes(plan.arg) };
        case 'condition':
            return { data: '', condition: 'is', condition_value: plan.arg ?? '' };
        case 'script':
            return { script: '' };
        case 'splittest':
            return { variants: [] };
        case 'action':
        default:
            if (plan.name === 'email') return { email_id: null };
            if (plan.name === 'sms') return { message: plan.arg ?? '' };
            if (plan.name === 'webhook' || plan.name === 'http') return { url: plan.arg ?? '', method: 'POST' };
            if (plan.name === 'tag') return { tag: plan.arg ?? '' };
            return {};
    }
}

/**
 * Assemble a Vue Flow `builder_config` from a trigger + a linear list of steps.
 * Nodes are chained top-to-bottom with default edges. Control nodes (wait /
 * condition / script / splittest) are fully wired; provider action nodes
 * (email / sms / crm / webhook) get `integration_id: null` and stub values —
 * they open correctly in the builder and just need credentials.
 */
function buildBuilderConfig(triggerId: string, triggerLabel: string, plans: StepPlan[]): BuilderConfig {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const X = 320;
    const STEP_Y = 140;
    let y = 80;

    const triggerNodeId = 'node_0';
    nodes.push({
        id: triggerNodeId, type: 'trigger', position: { x: X, y },
        data: { ef_type: triggerId, node_code: triggerNodeId, label: triggerLabel, label_group: 'Triggers', category: 'Triggers', values: {}, config: {} },
    });
    let prev = triggerNodeId;
    y += STEP_Y;

    plans.forEach((plan, i) => {
        const id = `node_${i + 1}`;
        const data: Record<string, unknown> = {
            ef_type: plan.def.ef, node_code: id, label: plan.name,
            category: categoryFor(plan.def.ef), values: nodeValues(plan), config: {},
        };
        // Provider action nodes carry an integration slot to fill in the builder.
        if (plan.def.render === 'action') data.integration_id = null;
        nodes.push({ id, type: plan.def.render, position: { x: X, y }, data });
        edges.push({ id: `e_${prev}_${id}`, source: prev, target: id, sourceHandle: null, targetHandle: null });
        prev = id;
        y += STEP_Y;
    });

    return { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

/** Split a "--steps" string on top-level commas (commas inside parens stay). */
function splitSteps(spec: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of spec) {
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
}

/** Parse + validate the steps DSL; throws a CliError listing valid names on a miss. */
function parseSteps(spec: string): StepPlan[] {
    const plans: StepPlan[] = [];
    for (const token of splitSteps(spec)) {
        const m = /^([a-zA-Z_][\w]*)\s*(?:\(([^)]*)\))?$/.exec(token);
        if (!m) {
            throw new CliError(ExitCode.Validation, `Cannot parse step "${token}". Use name or name(arg), e.g. email(welcome), wait(4d), condition(type=digital).`);
        }
        const name = m[1].toLowerCase();
        const def = STEP_ALIASES[name];
        if (!def) {
            throw new CliError(ExitCode.Validation, `Unknown step "${name}". Valid steps: ${Object.keys(STEP_ALIASES).sort().join(', ')}. See "ef automations node-types".`);
        }
        plans.push({ raw: token, name, arg: m[2]?.trim() || undefined, def });
    }
    return plans;
}

export function registerAutomationsCommand(program: Command): void {
    const cmd = program
        .command('automations')
        .description('Automations (triggered flows) — PREPARED: list, inspect triggers/node-types, create a shell.');

    cmd.command('list')
        .alias('ls')
        .description('List the brand\'s automations.')
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const rows = await api.listAutomations(rt.config.brandId);
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'title', 'trigger', 'status', 'updated'],
                rows: rows.map((a) => [
                    String(a.id),
                    a.title ?? '',
                    a.trigger_node_type ?? '',
                    a.status ?? '',
                    formatRelative(a.updated_at),
                ]),
            }) + '\n');
            log.detail(`${rows.length} automations`);
        });

    cmd.command('triggers')
        .description('Print the exact trigger identifiers automations can start on.')
        .option('--json', 'Print as JSON.')
        .action((opts: { json?: boolean }) => {
            if (opts.json) { log.json(TRIGGERS); return; }
            log.raw(renderTable({
                head: ['short (CLI)', 'canonical id', 'label'],
                rows: TRIGGERS.map((t) => [t.short, t.id, t.label]),
            }) + '\n');
            log.detail('Pass either form to "ef automations create --trigger <t>" (e.g. --trigger new_purchase).');
        });

    cmd.command('node-types')
        .description('Print the automation node/step types (render types + catalog categories).')
        .option('--json', 'Print as JSON.')
        .action((opts: { json?: boolean }) => {
            if (opts.json) {
                log.json({ renderTypes: RENDER_TYPES, stepAliases: STEP_ALIASES, categories: NODE_CATEGORIES });
                return;
            }
            log.info(c.bold('Render types (node shapes):') + ' ' + RENDER_TYPES.join(', '));
            log.info('');
            log.info(c.bold('Step aliases accepted by --steps:'));
            log.raw(renderTable({
                head: ['alias', 'render', 'canonical ef_type', 'what it does'],
                rows: Object.entries(STEP_ALIASES).map(([k, v]) => [k, v.render, v.ef, v.note]),
            }) + '\n');
            log.info(c.bold('Catalog categories (representative — many more per provider):'));
            for (const cat of NODE_CATEGORIES) log.info(`  ${c.cyan(cat.category)}: ${cat.examples.join(', ')}`);
        });

    cmd.command('delete <id>')
        .description('Delete an automation.')
        .option('--force', 'Do not require confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (id: string, opts: { force?: boolean; json?: boolean }) => {
            if (!/^\d+$/.test(id)) throw new CliError(ExitCode.Validation, `Expected a numeric automation id, got "${id}".`);
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const pid = parseInt(id, 10);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete automation #${pid}?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deleteAutomation(rt.config.brandId, pid);
            if (opts.json) { log.json({ ok: true, deleted: pid }); return; }
            log.success(`Deleted automation #${pid}.`);
        });

    cmd.command('create <title>')
        .description('Create an automation. With --trigger it lays down a DRAFT Vue Flow graph (trigger + steps); publish it in the builder.')
        .option('--trigger <t>', 'Trigger (e.g. new_purchase). Required to wire a graph — without it, only a shell is created.')
        .option('--steps <spec>', 'Comma-separated steps, e.g. "email(welcome), wait(4d), email(welcome)".')
        .option('--dry-run', 'Validate + print the plan and the builder_config graph without creating anything.')
        .option('--json', 'Print the result as JSON.')
        .action(async (title: string, opts: { trigger?: string; steps?: string; dryRun?: boolean; json?: boolean }) => {
            // Validate up front (works offline, before any server call).
            let triggerId: string | null = null;
            let triggerLabel = '';
            if (opts.trigger) {
                triggerId = normalizeTrigger(opts.trigger);
                if (!triggerId) {
                    throw new CliError(ExitCode.Validation,
                        `Unknown trigger "${opts.trigger}". Valid: ${TRIGGERS.map((t) => t.short).join(', ')}. See "ef automations triggers".`);
                }
                triggerLabel = TRIGGERS.find((t) => t.id === triggerId)?.label ?? triggerId;
            }
            const plans = opts.steps ? parseSteps(opts.steps) : [];
            if (plans.length > 0 && !triggerId) {
                throw new CliError(ExitCode.Validation, 'Steps need a --trigger — an automation graph must start at a trigger node. Add --trigger <t> or drop --steps.');
            }
            // Build the graph only when a trigger is present (an entry node is required).
            const graph = triggerId ? buildBuilderConfig(triggerId, triggerLabel, plans) : null;

            if (opts.dryRun) {
                if (opts.json) {
                    log.json({ ok: true, dryRun: true, title, trigger: triggerId, builderConfig: graph });
                    return;
                }
                log.info(`${c.bold('Dry run')} — would create automation ${c.bold(title)}`);
                if (graph) {
                    log.info(`  trigger: ${triggerId}`);
                    for (const p of plans) log.info(`  step: ${p.raw} → ${p.def.ef} (${p.def.render})`);
                    log.info(`  → would POST a DRAFT builder_config with ${graph.nodes.length} node(s), ${graph.edges.length} edge(s).`);
                } else {
                    log.info('  (no --trigger → shell only, no graph)');
                }
                log.detail('Nothing was created (--dry-run).');
                return;
            }

            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const created = await api.createAutomation(rt.config.brandId, title);
            if (graph) await api.saveAutomationBuilder(rt.config.brandId, created.id, graph, true);

            if (opts.json) {
                log.json({ ok: true, automation: created, wired: Boolean(graph), builderConfig: graph });
                return;
            }
            if (graph) {
                log.success(`Created automation #${created.id} "${created.title ?? title}" with a DRAFT graph (${graph.nodes.length} nodes).`);
                log.info(`  trigger: ${c.cyan(triggerId ?? '')}`);
                for (const p of plans) log.info(`  step:   ${p.raw} → ${c.cyan(p.def.ef)} (${p.def.render})`);
                const placeholders = plans.filter((p) => p.def.render === 'action');
                if (placeholders.length) {
                    log.warn(`${placeholders.length} action node(s) (${placeholders.map((p) => p.name).join(', ')}) need an integration/email selected in the builder.`);
                }
                log.detail('Saved as a DRAFT (not live). Open it in the automation builder to finish + publish.');
            } else {
                log.success(`Created automation #${created.id} "${created.title ?? title}" (empty shell — pass --trigger to wire a graph).`);
            }
        });
}
