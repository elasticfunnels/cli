import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { ApiClient } from '../api/client';
import { CrmEntity, CrmEntry } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatRelative, renderTable } from '../utils/format';
import { IMPORT_MAX_CHUNK, ImportPreview, importRows, previewImport } from '../api/crmImportApi';
import { buildImportPlan, ImportPlan } from '../models/crmImportPlan';
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
        .option('--limit <n>', 'Stop after this many rows (pages through as needed). Default: one page of 100.')
        .option('--page <n>', 'Start at this page (1-based, 100 rows per page).')
        .option('--all', 'Every entry: walk all pages.')
        .option('--json', 'Print as JSON (an array of entries).')
        .action(async (entity: string, opts: { pipeline?: string; stage?: string; fieldKey?: string; fieldValue?: string; q?: string; limit?: string; page?: string; all?: boolean; json?: boolean }) => {
            if (opts.all && opts.limit != null) throw new CliError(ExitCode.Validation, 'Use --all or --limit, not both.');
            const limit = opts.limit != null ? intOpt(opts.limit, '--limit', 1) : (opts.all ? Infinity : ENTRIES_PAGE);
            const startPage = opts.page != null ? intOpt(opts.page, '--page', 1) : 1;
            const { api, brandId } = await ctx();
            const filters: Record<string, string | number> = {};
            if (opts.pipeline) filters.pipeline_id = opts.pipeline;
            if (opts.stage) filters.stage_id = opts.stage;
            if (opts.fieldKey) filters.field_key = opts.fieldKey;
            if (opts.fieldValue) filters.field_value = opts.fieldValue;
            if (opts.q) filters.q = opts.q;
            const res = await fetchEntries(api, brandId, await resolveEntityId(api, brandId, entity), filters, startPage, limit, !opts.json);
            if (opts.json) { log.json(res.rows); return; }
            log.raw(renderTable({
                head: ['id', 'title', 'pipeline', 'stage', 'updated'],
                rows: res.rows.map((e) => [String(e.id), e.title ?? '', String(e.pipeline_id ?? ''), String(e.stage_id ?? ''), formatRelative(e.updated_at)]),
            }) + '\n');
            const first = (startPage - 1) * ENTRIES_PAGE + 1;
            const range = res.rows.length ? `rows ${first}-${first + res.rows.length - 1} of ${res.total}` : `0 of ${res.total}`;
            log.detail(res.more ? `${range}. More: --page ${res.nextPage}, or --all for every entry.` : `${range} entries`);
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

    registerImport(crm);
}

// ── entries paging ────────────────────────────────────────────────────

const ENTRIES_PAGE = 100;            // the server's per_page cap
const ES_WINDOW = 10_000;            // page * per_page past this needs the cursor

/** Walk pages from `startPage` until `limit` rows or the last page. Uses the `after` cursor when the server offers one. */
async function fetchEntries(api: ApiClient, brandId: number, entityId: number, filters: Record<string, string | number>,
    startPage: number, limit: number, progress: boolean): Promise<{ rows: CrmEntry[]; total: number; more: boolean; nextPage: number }> {
    const rows: CrmEntry[] = [];
    let page = startPage; let after: string | null = null; let total = 0; let more = false;
    for (;;) {
        const params: Record<string, string | number> = { ...filters, per_page: ENTRIES_PAGE };
        if (after != null) params.after = after; else params.page = page;
        const r = await api.listCrmEntriesPage(brandId, entityId, params);
        rows.push(...r.rows);
        total = r.total;
        const hasNext = r.nextAfter != null ? true : r.page < r.lastPage;
        if (rows.length >= limit) { more = rows.length > limit || (hasNext && r.rows.length > 0); break; }
        if (!r.rows.length || !hasNext) { more = false; break; }
        if (r.nextAfter != null) after = r.nextAfter;
        else if (page * ENTRIES_PAGE >= ES_WINDOW) {
            log.warn(`Stopped at row ${rows.length}: the server can't page past ${ES_WINDOW.toLocaleString('en-US')} rows yet. Narrow it with --stage, --pipeline or --q.`);
            more = true; break;
        }
        page++;
        if (progress && limit === Infinity && page % 10 === 0) log.detail(`…${rows.length} of ${total}`);
    }
    const kept = rows.slice(0, limit);
    // The page holding the first row not shown (rows before it on that page repeat when --limit cut mid-page).
    const nextPage = Math.floor(((startPage - 1) * ENTRIES_PAGE + kept.length) / ENTRIES_PAGE) + 1;
    return { rows: kept, total, more, nextPage };
}

// ── import ────────────────────────────────────────────────────────────

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

interface ImportOpts {
    file: string; preview?: boolean; map?: string[]; skip?: string[]; title?: string;
    pipeline?: string; stage?: string; offset?: string; batch?: string; yes?: boolean; json?: boolean;
}

function registerImport(crm: Command): void {
    crm.command('import <entity>')
        .description('Import entries from a CSV, TSV or XLSX file (first row = headers, first sheet, 20 MB / 20,000 rows max). '
            + 'Suggests a field per column, creates the new fields, then imports the rows in batches.')
        .requiredOption('--file <path>', 'The .csv, .tsv, .txt or .xlsx file.')
        .option('--preview', 'Show the column plan (field per column, samples) and stop. Writes nothing.')
        .option('--map <Column=key>', 'Map a column (header or 0-based index) to a field key; a new key is created with the suggested type. Repeatable.', collect)
        .option('--skip <column>', 'Leave a column out. Repeatable.', collect)
        .option('--title <column>', 'Column used as each entry\'s title (default: the server\'s pick, usually a name or email).')
        .option('--pipeline <id>', 'Pipeline id for the entries (default: the entity\'s default pipeline, when it has pipelines).')
        .option('--stage <id>', 'Stage id (default: the first stage of that pipeline).')
        .option('--offset <n>', 'Resume from this 0-based row (printed when a run stops early). Rows before it are not re-imported.', '0')
        .option('--batch <n>', `Rows per request (1-${IMPORT_MAX_CHUNK}).`, String(IMPORT_MAX_CHUNK))
        .option('-y, --yes', 'Import without the confirmation prompt (needed when not in a terminal).')
        .option('--json', 'Print the plan (with --preview) or the result as JSON.')
        .action(async (entity: string, opts: ImportOpts) => {
            const offset0 = intOpt(opts.offset ?? '0', '--offset', 0);
            const batch = intOpt(opts.batch ?? String(IMPORT_MAX_CHUNK), '--batch', 1, IMPORT_MAX_CHUNK);
            const filePath = path.resolve(opts.file);
            let bytes: Buffer;
            try { bytes = await fs.promises.readFile(filePath); } catch { throw new CliError(ExitCode.NotFound, `Can't read ${opts.file}.`); }

            const { api, brandId } = await ctx();
            const entityId = await resolveEntityId(api, brandId, entity);
            const [preview, existing] = await Promise.all([
                previewImport(api, brandId, entityId, { name: path.basename(filePath), bytes }),
                api.listCrmFields(brandId, entityId),
            ]);
            const existingKeys = new Set(existing.map((f) => String(f.key)));
            const plan = buildImportPlan(preview, existingKeys, { map: opts.map, skip: opts.skip, title: opts.title });
            const target = await importTarget(api, brandId, entityId, opts);

            if (opts.preview) {
                if (opts.json) { log.json({ file: preview.file_name, rows: preview.row_count, title_column: plan.titleColumn, pipeline_id: target.pipeline_id ?? null, stage_id: target.stage_id ?? null, columns: plan.columns, create: plan.create, mapping: plan.mapping }); return; }
                printPlan(preview, plan, target);
                log.detail('Preview only: nothing was written. Drop --preview to import (add --map / --skip to change the plan).');
                return;
            }
            if (offset0 >= preview.row_count) throw new CliError(ExitCode.Validation, `--offset ${offset0} is past the last row (${preview.row_count} rows).`);

            if (!opts.json) printPlan(preview, plan, target);
            if (!opts.yes) {
                if (!process.stdin.isTTY) throw new CliError(ExitCode.Validation, 'Pass --yes to import without a terminal (run with --preview first to check the plan).');
                const { confirm } = await import('../utils/prompt');
                const n = preview.row_count - offset0;
                const extra = plan.create.length ? ` and create ${plan.create.length} field${plan.create.length > 1 ? 's' : ''}` : '';
                if (!(await confirm(`Import ${n} row${n > 1 ? 's' : ''}${extra}?`, false))) throw new CliError(ExitCode.Validation, 'Aborted.');
            }

            const created: string[] = [];
            for (const f of plan.create) {
                const payload: Record<string, unknown> = { label: f.label, key: f.key, type: f.type };
                if (f.options && f.options.length) payload.options = f.options;
                await api.createCrmField(brandId, entityId, payload);
                created.push(f.key);
                if (!opts.json) log.info(`Created field ${f.key} (${f.type}).`);
            }

            const totals = { imported: 0, skipped: 0, failed: 0 };
            const errors: Array<{ row: number; message: string }> = [];
            let offset = offset0;
            for (;;) {
                let r;
                try {
                    r = await importRows(api, brandId, entityId, {
                        file_hash: preview.file_hash, mapping: plan.mapping, title_column: plan.titleColumn,
                        ...target, offset, limit: batch,
                    });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    throw new CliError(err instanceof CliError ? err.code : ExitCode.Error,
                        `${msg}\nImported ${totals.imported} so far. Rows before ${offset} are in; resume with: ef crm import ${entity} --file ${opts.file} --offset ${offset}${opts.map?.length ? ' (same --map/--skip)' : ''} --yes`);
                }
                totals.imported += r.imported; totals.skipped += r.skipped; totals.failed += r.failed;
                errors.push(...r.errors);
                if (!opts.json) log.detail(`rows ${offset + 1}-${Math.min(r.next_offset, r.total)} of ${r.total}: ${r.imported} imported, ${r.skipped} skipped, ${r.failed} failed`);
                if (r.done || r.next_offset <= offset) break;
                offset = r.next_offset;
            }

            const result = { ok: totals.failed === 0, entity_id: entityId, file: preview.file_name, rows: preview.row_count, offset: offset0, ...totals, fields_created: created, errors };
            if (opts.json) { log.json(result); return; }
            log.success(`Imported ${totals.imported} entr${totals.imported === 1 ? 'y' : 'ies'} into ${entity} (${totals.skipped} skipped, ${totals.failed} failed).`);
            for (const e of errors.slice(0, 20)) log.warn(`row ${e.row}: ${e.message}`);
            if (errors.length > 20) log.detail(`…and ${errors.length - 20} more row errors (use --json for all).`);
        });
}

function intOpt(raw: string, flag: string, min: number, max?: number): number {
    if (!/^\d+$/.test(raw)) throw new CliError(ExitCode.Validation, `${flag} must be a whole number, got "${raw}".`);
    const v = parseInt(raw, 10);
    if (v < min || (max != null && v > max)) throw new CliError(ExitCode.Validation, `${flag} must be ${max != null ? `between ${min} and ${max}` : `at least ${min}`}.`);
    return v;
}

/** Pipeline + stage: flags, else the default pipeline's first stage when the entity has pipelines. */
async function importTarget(api: ApiClient, brandId: number, entityId: number, opts: ImportOpts): Promise<{ pipeline_id?: number; stage_id?: number }> {
    const out: { pipeline_id?: number; stage_id?: number } = {};
    if (opts.pipeline != null) out.pipeline_id = numeric(opts.pipeline, 'pipeline');
    if (opts.stage != null) out.stage_id = numeric(opts.stage, 'stage');
    if (out.pipeline_id != null && out.stage_id != null) return out;
    const pipelines = await api.listCrmPipelines(brandId, entityId);
    if (!pipelines.length) {
        if (out.pipeline_id != null || out.stage_id != null) throw new CliError(ExitCode.Validation, 'This entity has no pipelines: drop --pipeline/--stage.');
        return out;
    }
    const pipe = out.pipeline_id != null ? pipelines.find((p) => p.id === out.pipeline_id) : (pipelines.find((p) => p.is_default) ?? pipelines[0]);
    if (!pipe) throw new CliError(ExitCode.NotFound, `Pipeline #${out.pipeline_id} is not on this entity. Run "ef crm pipelines <entity>".`);
    out.pipeline_id = pipe.id;
    if (out.stage_id == null) {
        const stages = (pipe.stages && pipe.stages.length ? pipe.stages : await api.listCrmStages(brandId, pipe.id))
            .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (!stages.length) throw new CliError(ExitCode.Validation, `Pipeline #${pipe.id} has no stages. Add one with "ef crm stages create ${pipe.id}" or pass --stage.`);
        out.stage_id = stages[0].id;
    }
    return out;
}

function printPlan(preview: ImportPreview, plan: ImportPlan, target: { pipeline_id?: number; stage_id?: number }): void {
    log.info(`${preview.file_name}: ${preview.row_count} row${preview.row_count === 1 ? '' : 's'}, ${preview.columns.length} columns.`);
    log.raw(renderTable({
        head: ['#', 'column', 'action', 'field', 'type', 'samples'],
        rows: plan.columns.map((c) => [
            String(c.index), c.header, c.action, c.key ?? '', c.field?.type ?? (c.action === 'existing' ? '(existing)' : ''),
            c.samples.join(' | ').slice(0, 50),
        ]),
    }) + '\n');
    const title = plan.titleColumn != null ? (preview.columns.find((c) => c.index === plan.titleColumn)?.header ?? String(plan.titleColumn)) : 'first mapped value';
    const where = target.pipeline_id != null ? `; pipeline #${target.pipeline_id}, stage #${target.stage_id}` : '';
    log.detail(`Title from: ${title}${where}. New fields: ${plan.create.length ? plan.create.map((f) => `${f.key} (${f.type})`).join(', ') : 'none'}.`);
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
