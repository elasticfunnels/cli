import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CrmEntity } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatRelative, renderTable } from '../utils/format';
import { addInputOptions, JsonInputOpts, loadInputBase, maybeGenerateSkeleton, mergeDefined } from '../utils/jsonInput';

// ── Skeletons for --generate-skeleton ─────────────────────────────────
const ENTITY_SKELETON = { name: 'Leads', slug: 'leads', singular_name: 'Lead', plural_name: 'Leads', entity_mode: 'crm', icon: null, color: null };
const PIPELINE_SKELETON = { name: 'Sales Pipeline', slug: 'sales', purpose: 'sales', is_default: false };
const STAGE_SKELETON = { name: 'Qualified', slug: 'qualified', color: '#22c55e', order: 1, probability: 50, semantic_status: 'open' };
const FIELD_SKELETON = { label: 'Budget', key: 'budget', type: 'text', options: null };
const ENTRY_SKELETON = { title: 'Jane Doe', pipeline_id: 0, stage_id: 0, values: { email: 'jane@example.com' }, reference_type: 'customer', reference_id: null };
const ENTRY_UPDATE_SKELETON = { title: 'Jane Doe', stage_id: 0, values: { budget: 5000 } };

const FIELD_TYPES = ['text', 'textarea', 'rich_text', 'wysiwyg', 'email', 'phone', 'url', 'number', 'date', 'datetime', 'boolean', 'select', 'multiselect', 'color', 'image', 'file', 'json', 'reference', 'multi_reference'];

// ── Helpers ───────────────────────────────────────────────────────────

function numeric(v: string, what: string): number {
    if (!/^\d+$/.test(v)) throw new CliError(ExitCode.Validation, `Expected a numeric ${what} id, got "${v}".`);
    return parseInt(v, 10);
}

/** Accept a CRM entity by numeric id or by slug (resolved via the entity list). */
async function resolveEntityId(api: ApiClient, brandId: number, ref: string): Promise<number> {
    if (/^\d+$/.test(ref)) return parseInt(ref, 10);
    const entities = await api.listCrmEntities(brandId);
    const hit = entities.find((e: CrmEntity) => e.slug === ref || e.name === ref);
    if (!hit) {
        throw new CliError(ExitCode.NotFound, `No CRM entity with slug "${ref}". Run "ef crm entities" to list them (or pass a numeric id).`);
    }
    return hit.id;
}

/** Parse a --values JSON object flag. */
function parseValues(raw: string | undefined): Record<string, unknown> | undefined {
    if (raw == null) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (err) { throw new CliError(ExitCode.Validation, `--values must be a JSON object: ${(err as Error).message}`); }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(ExitCode.Validation, '--values must be a JSON object, e.g. \'{"budget":5000}\'.');
    return parsed as Record<string, unknown>;
}

export function registerCrmCommand(program: Command): void {
    const crm = program.command('crm').description('CRM: entities, pipelines, stages, fields, entries.');

    // ── entities ──────────────────────────────────────────────────────
    const entities = crm.command('entities').description('CRM object types (Leads, Deals, form collections…).');

    entities.command('list', { isDefault: true })
        .alias('ls')
        .description('List CRM entities.')
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const rows = await api.listCrmEntities(brandId);
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'slug', 'name', 'mode', 'system'],
                rows: rows.map((e) => [String(e.id), e.slug ?? '', e.name ?? '', e.entity_mode ?? '', e.is_system ? 'yes' : '']),
            }) + '\n');
            log.detail(`${rows.length} entities`);
        });

    entities.command('get <entity>')
        .description('Print one CRM entity (by id or slug) as JSON.')
        .action(async (entity: string) => {
            const { api, brandId } = await ctx();
            log.json(await api.getCrmEntity(brandId, await resolveEntityId(api, brandId, entity)));
        });

    addInputOptions(entities.command('create')
        .description('Create a CRM entity. Flags override --input-json/--input-file fields.'))
        .option('--name <name>', 'Display name.')
        .option('--slug <slug>', 'Machine slug (lowercase, unique per brand).')
        .option('--singular <name>', 'Singular label.')
        .option('--plural <name>', 'Plural label.')
        .option('--entity-mode <mode>', 'crm | data.')
        .option('--preset <key>', 'Install a preset (pipelines+stages+fields) — see server presets.')
        .option('--json', 'Print result as JSON.')
        .action(async (opts: JsonInputOpts & Record<string, string | boolean>) => {
            if (maybeGenerateSkeleton(opts, ENTITY_SKELETON)) return;
            const payload = mergeDefined(await loadInputBase(opts), {
                name: opts.name, slug: opts.slug, singular_name: opts.singular, plural_name: opts.plural,
                entity_mode: opts.entityMode, preset: opts.preset,
            });
            if (!payload.name) throw new CliError(ExitCode.Validation, 'A --name (or "name" in the JSON payload) is required.');
            const { api, brandId } = await ctx();
            const created = await api.createCrmEntity(brandId, payload);
            if (opts.json) { log.json({ ok: true, entity: created }); return; }
            log.success(`Created CRM entity #${created.id} (${created.slug ?? payload.slug ?? payload.name}).`);
        });

    entities.command('delete <entity>')
        .description('Delete a CRM entity (by id or slug).')
        .option('--force', 'Skip confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (entity: string, opts: { force?: boolean; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const id = await resolveEntityId(api, brandId, entity);
            await confirmOrThrow(opts.force, `Delete CRM entity #${id} and its pipelines/fields?`);
            await api.deleteCrmEntity(brandId, id);
            if (opts.json) { log.json({ ok: true, deleted: id }); return; }
            log.success(`Deleted CRM entity #${id}.`);
        });

    // ── pipelines ─────────────────────────────────────────────────────
    const pipelines = crm.command('pipelines').description('Pipelines within a CRM entity.');

    pipelines.command('list <entity>', { isDefault: true })
        .alias('ls')
        .description('List pipelines (with their stages) for an entity (id or slug).')
        .option('--json', 'Print as JSON.')
        .action(async (entity: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const rows = await api.listCrmPipelines(brandId, await resolveEntityId(api, brandId, entity));
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'slug', 'name', 'purpose', 'default', 'stages'],
                rows: rows.map((p) => [String(p.id), p.slug ?? '', p.name ?? '', p.purpose ?? '', p.is_default ? 'yes' : '', String(p.stages?.length ?? 0)]),
            }) + '\n');
            log.detail(`${rows.length} pipelines`);
        });

    addInputOptions(pipelines.command('create <entity>')
        .description('Create a pipeline under an entity (id or slug).'))
        .option('--name <name>', 'Pipeline name.')
        .option('--slug <slug>', 'Slug (auto from name if omitted).')
        .option('--purpose <purpose>', 'callcenter | sales | support.')
        .option('--default', 'Make this the default pipeline for the entity.')
        .option('--json', 'Print result as JSON.')
        .action(async (entity: string, opts: JsonInputOpts & Record<string, string | boolean>) => {
            if (maybeGenerateSkeleton(opts, PIPELINE_SKELETON)) return;
            const payload = mergeDefined(await loadInputBase(opts), {
                name: opts.name, slug: opts.slug, purpose: opts.purpose,
                is_default: opts.default ? true : undefined,
            });
            if (!payload.name) throw new CliError(ExitCode.Validation, 'A --name (or "name" in the JSON payload) is required.');
            const { api, brandId } = await ctx();
            const created = await api.createCrmPipeline(brandId, await resolveEntityId(api, brandId, entity), payload);
            if (opts.json) { log.json({ ok: true, pipeline: created }); return; }
            log.success(`Created pipeline #${created.id} (${created.slug ?? payload.name}).`);
        });

    pipelines.command('delete <pipeline>')
        .description('Delete a pipeline by id.')
        .option('--force', 'Skip confirmation.')
        .option('--json', 'Print result as JSON.')
        .action(async (pipeline: string, opts: { force?: boolean; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const id = numeric(pipeline, 'pipeline');
            await confirmOrThrow(opts.force, `Delete pipeline #${id} and its stages?`);
            await api.deleteCrmPipeline(brandId, id);
            if (opts.json) { log.json({ ok: true, deleted: id }); return; }
            log.success(`Deleted pipeline #${id}.`);
        });

    // ── stages ────────────────────────────────────────────────────────
    const stages = crm.command('stages').description('Stages (columns) within a pipeline.');

    stages.command('list <pipeline>', { isDefault: true })
        .alias('ls')
        .description('List stages for a pipeline id.')
        .option('--json', 'Print as JSON.')
        .action(async (pipeline: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const rows = await api.listCrmStages(brandId, numeric(pipeline, 'pipeline'));
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'order', 'slug', 'name', 'prob', 'status'],
                rows: rows.map((s) => [String(s.id), String(s.order ?? ''), s.slug ?? '', s.name ?? '', String(s.probability ?? ''), s.semantic_status ?? '']),
            }) + '\n');
            log.detail(`${rows.length} stages`);
        });

    addInputOptions(stages.command('create <pipeline>')
        .description('Create a stage under a pipeline id.'))
        .option('--name <name>', 'Stage name.')
        .option('--slug <slug>', 'Slug.')
        .option('--order <n>', 'Sort order.', (v) => parseInt(v, 10))
        .option('--probability <n>', 'Win probability 0-100.', (v) => parseInt(v, 10))
        .option('--semantic-status <s>', 'open | won | lost.')
        .option('--color <hex>', 'Stage color.')
        .option('--json', 'Print result as JSON.')
        .action(async (pipeline: string, opts: JsonInputOpts & Record<string, string | number | boolean>) => {
            if (maybeGenerateSkeleton(opts, STAGE_SKELETON)) return;
            const payload = mergeDefined(await loadInputBase(opts), {
                name: opts.name, slug: opts.slug, order: opts.order, probability: opts.probability,
                semantic_status: opts.semanticStatus, color: opts.color,
            });
            if (!payload.name) throw new CliError(ExitCode.Validation, 'A --name (or "name" in the JSON payload) is required.');
            const { api, brandId } = await ctx();
            const created = await api.createCrmStage(brandId, numeric(pipeline, 'pipeline'), payload);
            if (opts.json) { log.json({ ok: true, stage: created }); return; }
            log.success(`Created stage #${created.id} (${created.slug ?? payload.name}).`);
        });

    stages.command('delete <stage>')
        .description('Delete a stage by id.')
        .option('--force', 'Skip confirmation.')
        .option('--json', 'Print result as JSON.')
        .action(async (stage: string, opts: { force?: boolean; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const id = numeric(stage, 'stage');
            await confirmOrThrow(opts.force, `Delete stage #${id}?`);
            await api.deleteCrmStage(brandId, id);
            if (opts.json) { log.json({ ok: true, deleted: id }); return; }
            log.success(`Deleted stage #${id}.`);
        });

    // ── fields ────────────────────────────────────────────────────────
    const fields = crm.command('fields').description('Custom field definitions for an entity.');

    fields.command('list <entity>', { isDefault: true })
        .alias('ls')
        .description('List custom fields for an entity (id or slug).')
        .option('--json', 'Print as JSON.')
        .action(async (entity: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const rows = await api.listCrmFields(brandId, await resolveEntityId(api, brandId, entity));
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'key', 'label', 'type'],
                rows: rows.map((f) => [String(f.id), f.key ?? '', f.label ?? '', f.type ?? '']),
            }) + '\n');
            log.detail(`${rows.length} fields`);
        });

    addInputOptions(fields.command('create <entity>')
        .description(`Create a custom field. Types: ${FIELD_TYPES.join(', ')}.`))
        .option('--label <label>', 'Field label.')
        .option('--key <key>', 'Field key (machine name).')
        .option('--type <type>', `Field type (${FIELD_TYPES.join(' | ')}).`)
        .option('--json', 'Print result as JSON.')
        .action(async (entity: string, opts: JsonInputOpts & Record<string, string | boolean>) => {
            if (maybeGenerateSkeleton(opts, FIELD_SKELETON)) return;
            const payload = mergeDefined(await loadInputBase(opts), { label: opts.label, key: opts.key, type: opts.type });
            if (!payload.label || !payload.key || !payload.type) throw new CliError(ExitCode.Validation, '--label, --key and --type are required (or provide them in the JSON payload).');
            if (typeof payload.type === 'string' && !FIELD_TYPES.includes(payload.type)) {
                throw new CliError(ExitCode.Validation, `Unknown field type "${payload.type}". Valid: ${FIELD_TYPES.join(', ')}.`);
            }
            const { api, brandId } = await ctx();
            const created = await api.createCrmField(brandId, await resolveEntityId(api, brandId, entity), payload);
            if (opts.json) { log.json({ ok: true, field: created }); return; }
            log.success(`Created field #${created.id} (${created.key ?? payload.key}).`);
        });

    fields.command('delete <field>')
        .description('Delete a custom field by id.')
        .option('--force', 'Skip confirmation.')
        .option('--json', 'Print result as JSON.')
        .action(async (field: string, opts: { force?: boolean; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const id = numeric(field, 'field');
            await confirmOrThrow(opts.force, `Delete field #${id}?`);
            await api.deleteCrmField(brandId, id);
            if (opts.json) { log.json({ ok: true, deleted: id }); return; }
            log.success(`Deleted field #${id}.`);
        });

    // ── entries ───────────────────────────────────────────────────────
    const entries = crm.command('entries').description('CRM entries (cards/contacts) — stored in Elasticsearch.');

    entries.command('list <entity>', { isDefault: true })
        .alias('ls')
        .description('List entries for an entity (id or slug), with optional filters.')
        .option('--pipeline <id>', 'Filter by pipeline id.')
        .option('--stage <id>', 'Filter by stage id.')
        .option('--field-key <key>', 'Filter by a field key (with --field-value).')
        .option('--field-value <val>', 'Value for --field-key.')
        .option('--q <text>', 'Free-text search.')
        .option('--limit <n>', 'Max rows (per_page).', (v) => parseInt(v, 10))
        .option('--json', 'Print as JSON.')
        .action(async (entity: string, opts: { pipeline?: string; stage?: string; fieldKey?: string; fieldValue?: string; q?: string; limit?: number; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const filters: Record<string, string | number> = {};
            if (opts.pipeline) filters.pipeline_id = opts.pipeline;
            if (opts.stage) filters.stage_id = opts.stage;
            if (opts.fieldKey) filters.field_key = opts.fieldKey;
            if (opts.fieldValue) filters.field_value = opts.fieldValue;
            if (opts.q) filters.q = opts.q;
            if (opts.limit) filters.per_page = opts.limit;
            const rows = await api.listCrmEntries(brandId, await resolveEntityId(api, brandId, entity), filters);
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['id', 'title', 'pipeline', 'stage', 'updated'],
                rows: rows.map((e) => [String(e.id), e.title ?? '', String(e.pipeline_id ?? ''), String(e.stage_id ?? ''), formatRelative(e.updated_at)]),
            }) + '\n');
            log.detail(`${rows.length} entries`);
        });

    entries.command('get <entry>')
        .description('Print one entry (by ES id) as JSON.')
        .action(async (entry: string) => {
            const { api, brandId } = await ctx();
            log.json(await api.getCrmEntry(brandId, entry));
        });

    addInputOptions(entries.command('create <entity>')
        .description('Create an entry under an entity (id or slug). crm-mode entities require --pipeline + --stage.'))
        .option('--title <title>', 'Entry title.')
        .option('--pipeline <id>', 'Pipeline id.', (v) => parseInt(v, 10))
        .option('--stage <id>', 'Stage id.', (v) => parseInt(v, 10))
        .option('--values <json>', 'Flat field values as a JSON object, e.g. \'{"budget":5000}\'.')
        .option('--reference-type <type>', 'Reference type (e.g. customer).')
        .option('--reference-id <id>', 'Reference id.')
        .option('--json', 'Print result as JSON.')
        .action(async (entity: string, opts: JsonInputOpts & Record<string, string | number | boolean | undefined>) => {
            if (maybeGenerateSkeleton(opts, ENTRY_SKELETON)) return;
            const payload = mergeDefined(await loadInputBase(opts), {
                title: opts.title, pipeline_id: opts.pipeline, stage_id: opts.stage,
                values: parseValues(opts.values as string | undefined),
                reference_type: opts.referenceType, reference_id: opts.referenceId,
            });
            const { api, brandId } = await ctx();
            const created = await api.createCrmEntry(brandId, await resolveEntityId(api, brandId, entity), payload);
            if (opts.json) { log.json({ ok: true, entry: created }); return; }
            log.success(`Created CRM entry ${created.id}${created.title ? ` (${created.title})` : ''}.`);
        });

    addInputOptions(entries.command('update <entry>')
        .description('Update an entry (by ES id). values are merged into the existing ones.'))
        .option('--title <title>', 'New title.')
        .option('--stage <id>', 'Move to stage id.', (v) => parseInt(v, 10))
        .option('--values <json>', 'Flat field values to merge, e.g. \'{"budget":6000}\'.')
        .option('--json', 'Print result as JSON.')
        .action(async (entry: string, opts: JsonInputOpts & Record<string, string | number | undefined>) => {
            if (maybeGenerateSkeleton(opts, ENTRY_UPDATE_SKELETON)) return;
            const payload = mergeDefined(await loadInputBase(opts), {
                title: opts.title, stage_id: opts.stage, values: parseValues(opts.values as string | undefined),
            });
            if (Object.keys(payload).length === 0) throw new CliError(ExitCode.Validation, 'Nothing to update — pass --title, --stage, --values, or a JSON payload.');
            const { api, brandId } = await ctx();
            const updated = await api.updateCrmEntry(brandId, entry, payload);
            if (opts.json) { log.json({ ok: true, entry: updated }); return; }
            log.success(`Updated CRM entry ${entry}.`);
        });

    entries.command('move <entry>')
        .description('Move an entry to a stage.')
        .requiredOption('--stage <id>', 'Target stage id.', (v) => parseInt(v, 10))
        .option('--json', 'Print result as JSON.')
        .action(async (entry: string, opts: { stage: number; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const updated = await api.moveCrmEntry(brandId, entry, opts.stage);
            if (opts.json) { log.json({ ok: true, entry: updated }); return; }
            log.success(`Moved CRM entry ${entry} to stage #${opts.stage}.`);
        });

    entries.command('delete <entry>')
        .description('Delete an entry by ES id.')
        .option('--force', 'Skip confirmation.')
        .option('--json', 'Print result as JSON.')
        .action(async (entry: string, opts: { force?: boolean; json?: boolean }) => {
            const { api, brandId } = await ctx();
            await confirmOrThrow(opts.force, `Delete CRM entry ${entry}?`);
            await api.deleteCrmEntry(brandId, entry);
            if (opts.json) { log.json({ ok: true, deleted: entry }); return; }
            log.success(`Deleted CRM entry ${entry}.`);
        });
}

/** Load runtime + api once per action. */
async function ctx(): Promise<{ api: ApiClient; brandId: number }> {
    const rt = await loadRuntime();
    return { api: new ApiClient(rt.config.apiUrl, rt.apiKey), brandId: rt.config.brandId };
}

async function confirmOrThrow(force: boolean | undefined, prompt: string): Promise<void> {
    if (force || !process.stdin.isTTY) return;
    const { confirm } = await import('../utils/prompt');
    if (!(await confirm(prompt, false))) throw new CliError(ExitCode.Validation, 'Aborted.');
}
