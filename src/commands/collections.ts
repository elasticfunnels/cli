import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { BrandCollection, BrandCollectionField, COLLECTION_FIELD_TYPES } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';
import { readJsonPayloadFile } from './shared';

/**
 * `ef collections` — the form store behind a lead-capture `<form>`.
 *
 * Why this exists: a form is wired to a collection by its **code**, and the
 * code is server-generated. Without a CLI surface the only way to obtain one
 * was to push a form and read back whatever the server rewrote — which meant
 * you could not write correct markup up front, and could not check whether a
 * form was storing anything. `ef collections create` returns the code, so a
 * page can be authored against a real one in a single pass.
 */

/**
 * Parse a `--field` spec: `Name[:type[:required]]`.
 *
 * Deliberately positional and tiny — a lead form is usually two or three text
 * fields, and making that case a one-liner is the whole point. Anything richer
 * (select options, defaults, privacy flags) goes through --input-json.
 */
export function parseFieldSpec(spec: string): BrandCollectionField {
    const parts = spec.split(':').map((p) => p.trim());
    const name = parts[0];
    if (!name) {
        throw new CliError(ExitCode.Validation, `Empty --field spec. Use "Name", "Name:email", or "Name:email:required".`);
    }
    const type = (parts[1] || 'text').toLowerCase();
    if (!(COLLECTION_FIELD_TYPES as readonly string[]).includes(type)) {
        throw new CliError(
            ExitCode.Validation,
            `Unknown field type "${type}" in --field "${spec}". Valid types: ${COLLECTION_FIELD_TYPES.join(', ')}.`,
        );
    }
    const flag = (parts[2] || '').toLowerCase();
    if (flag && flag !== 'required' && flag !== 'optional') {
        throw new CliError(ExitCode.Validation, `Unknown flag "${parts[2]}" in --field "${spec}". Use "required" or omit it.`);
    }
    return { name, type, required: flag === 'required' };
}

function printCollections(rows: BrandCollection[], json?: boolean): void {
    if (json) { log.json({ ok: true, collections: rows }); return; }
    if (!rows.length) {
        log.info('No collections in this brand yet. Create one with "ef collections create <name> --field Email:email:required".');
        return;
    }
    log.raw(renderTable({
        head: ['id', 'code', 'name', 'entries'],
        rows: rows.map((r) => [String(r.id), r.code ?? '', r.name ?? '', r.total_entries != null ? String(r.total_entries) : '']),
    }) + '\n');
}

function printFields(fields: BrandCollectionField[]): void {
    if (!fields.length) { log.detail('  (no fields)'); return; }
    log.raw(renderTable({
        head: ['name', 'key', 'type', 'required'],
        rows: fields.map((f) => [f.name ?? '', f.key ?? '', String(f.type ?? ''), f.required ? 'yes' : '']),
    }) + '\n');
}

export function registerCollectionsCommand(program: Command): void {
    const cmd = program
        .command('collections')
        .alias('collection')
        .description('Form stores — list, inspect and create the collections that lead-capture forms write to.')
        .addHelpText('after', `
A <form> stores submissions in a collection, referenced by the collection's
CODE. Two ways to get one:

  1. Let the server do it. Push a page with a plain <form> (no "action") and it
     auto-creates a collection and rewrites the form. "ef push" prints the code.
     Not available on pages containing {{ }} or @if/@foreach — the server skips
     form wiring there.

  2. Create it up front, then write the markup yourself:

     $ ef collections create "Newsletter" --field Email:email:required --json
     # → { "code": "newsletter-a1b2", ... }
     $ # then in the page:
     $ #   <form action="/api/collection/newsletter-a1b2/store" method="post">

Option 2 is the reliable one for template-heavy pages, and the only one that
lets you author correct markup in a single pass.`);

    cmd.command('list')
        .alias('ls')
        .description('List the brand\'s collections with their codes.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            printCollections(await api.listCollections(rt.config.brandId), opts.json);
        });

    cmd.command('get <codeOrId>')
        .description('Show one collection and its fields. Accepts the code or the numeric id.')
        .option('--json', 'Print as JSON.')
        .action(async (ref: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const col = await api.getCollection(rt.config.brandId, ref);
            if (opts.json) { log.json({ ok: true, collection: col }); return; }
            log.info(`${c.bold('Collection')}  ${col.name} (${c.cyan(col.code)}, #${col.id})`);
            if (col.total_entries != null) log.info(`${c.bold('Entries')}     ${col.total_entries}`);
            log.info(`${c.bold('Form action')} /api/collection/${col.code}/store`);
            printFields(col.fields ?? []);
        });

    cmd.command('fields <codeOrId>')
        .description('List a collection\'s fields.')
        .option('--json', 'Print as JSON.')
        .action(async (ref: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const fields = await api.getCollectionFields(rt.config.brandId, ref);
            if (opts.json) { log.json({ ok: true, fields }); return; }
            printFields(fields);
        });

    cmd.command('entries <codeOrId>')
        .description('List submitted entries for a collection — use this to confirm a form is actually storing data.')
        .option('--limit <n>', 'Max entries to return.', (v) => parseInt(v, 10))
        .option('--json', 'Print as JSON.')
        .action(async (ref: string, opts: { limit?: number; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const entries = await api.listCollectionEntries(rt.config.brandId, ref, opts.limit ? { limit: opts.limit } : undefined);
            if (opts.json) { log.json({ ok: true, entries }); return; }
            if (!entries.length) {
                log.info('No entries yet.');
                log.detail('  If a form should have written here, check its action is "/api/collection/<code>/store" and that the page has no {{ }} / @directives blocking auto-wiring.');
                return;
            }
            log.info(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:`);
            for (const e of entries) log.raw(JSON.stringify(e) + '\n');
        });

    cmd.command('create <name>')
        .description('Create a collection and print its code — the value a form\'s action must reference.')
        .addHelpText('after', `
Examples:
  $ ef collections create "Newsletter" --field Email:email:required
  $ ef collections create "Quiz leads" \\
      --field "First name" --field Email:email:required --field "Phone:text"
  $ ef collections create "Contact" --input-file ./collection.json

Field spec: Name[:type[:required]]   (type defaults to "text")
Types: ${COLLECTION_FIELD_TYPES.join(', ')}

For select options, defaults or privacy flags, pass the full payload with
--input-json / --input-file: { "name": "...", "fields": [ { "name": "...",
"type": "select", "options": ["a","b"] } ] }`)
        .option('--field <spec...>', 'A field as Name[:type[:required]]. Repeatable.')
        .option('--input-json <json>', 'Full JSON payload (flags below still override name/fields).')
        .option('--input-file <path>', 'Read the JSON payload from a file ("-" for stdin).')
        .option('--notify <email>', 'Email address to notify on every new entry.')
        .option('--json', 'Print the created collection as JSON.')
        .action(async (name: string, opts: {
            field?: string[]; inputJson?: string; inputFile?: string; notify?: string; json?: boolean;
        }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);

            let base: Record<string, unknown> = {};
            if (opts.inputFile) base = await readJsonPayloadFile(opts.inputFile) as Record<string, unknown>;
            else if (opts.inputJson) {
                try { base = JSON.parse(opts.inputJson) as Record<string, unknown>; } catch (err) {
                    throw new CliError(ExitCode.Validation, `--input-json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const fromFlags = (opts.field ?? []).map(parseFieldSpec);
            const fields = fromFlags.length ? fromFlags : (base.fields as BrandCollectionField[] | undefined) ?? [];
            if (!fields.length) {
                throw new CliError(
                    ExitCode.Validation,
                    'A collection needs at least one field. Add --field Email:email:required (repeatable), or pass fields via --input-json/--input-file.',
                );
            }

            const payload = {
                ...base,
                name,
                fields,
                ...(opts.notify ? { on_new_entry: 'send_email_to', send_to_email: opts.notify } : {}),
            };

            const created = await api.createCollection(rt.config.brandId, payload);
            if (opts.json) { log.json({ ok: true, collection: created }); return; }
            log.success(`Created collection "${created.name}" — code ${c.cyan(created.code)} (#${created.id}).`);
            log.info(`  Wire a form to it with:  ${c.dim(`<form action="/api/collection/${created.code}/store" method="post">`)}`);
            printFields(created.fields ?? fields);
        });
}
