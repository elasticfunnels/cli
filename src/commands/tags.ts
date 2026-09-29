import { Command } from 'commander';
import { ApiClient } from '../api/client';
import {
    BrandTag,
    Component,
    Page,
    TAG_AUTO_COLORS,
    TAG_COLORS,
    TAGGABLE,
    TaggableKind,
} from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';
import { resolveComponentByCodeOrName, resolvePageBySlug } from './shared';

/**
 * `ef tags` — the coloured labels the dashboard shows against pages and
 * components.
 *
 * Why the CLI has them: a brand accumulates hundreds of pages, and the only
 * durable way to say "these six belong to the March quiz funnel" is a tag —
 * slugs get renamed, folders hold one page each, and a naming convention is a
 * convention nobody else follows. Anything that CREATES pages in bulk (an
 * agent, an import script) should tag as it goes, because retro-tagging means
 * re-identifying the pages by hand later.
 *
 * Two distinct verbs, deliberately not spelled alike:
 *   attach/detach  — put a tag on / take it off ONE record.
 *   delete         — remove the tag from the brand entirely.
 */

/** A resolved tag target: a real record id plus the module key it stores under. */
export interface TagTarget {
    kind: TaggableKind;
    moduleKey: string;
    id: number;
    /** Human label for output — a slug or a component code. */
    label: string;
}

/**
 * Split `component:hero` into a kind and a reference.
 *
 * An unknown prefix is NOT an error: page slugs are the overwhelmingly common
 * argument and they are free-form paths, so anything that doesn't start with a
 * kind we recognise is treated whole as a page reference. That makes
 * `ef tags attach shop/product/{code} sale` work without ceremony, at the cost
 * of turning a typo'd prefix into a "no page with slug ..." error — which names
 * the string it looked for, so the mistake is visible.
 */
export function parseTargetRef(raw: string): { kind: TaggableKind; ref: string } {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) throw new CliError(ExitCode.Validation, 'Empty target. Pass a page slug, or "component:<code>".');

    const idx = trimmed.indexOf(':');
    if (idx > 0) {
        const prefix = trimmed.slice(0, idx).toLowerCase();
        const rest = trimmed.slice(idx + 1).trim();
        const kind = KIND_ALIASES[prefix];
        if (kind) {
            if (!rest) throw new CliError(ExitCode.Validation, `Missing reference after "${prefix}:".`);
            return { kind, ref: rest };
        }
    }
    return { kind: 'page', ref: trimmed };
}

const KIND_ALIASES: Record<string, TaggableKind> = {
    page: 'page',
    pages: 'page',
    component: 'component',
    components: 'component',
    comp: 'component',
};

/**
 * Turn a colour argument into what the server stores.
 *
 * Accepts one of the dashboard's swatch names, `#rgb`/`#rrggbb`, or
 * `rgb(r,g,b)`. Whitespace inside `rgb()` is squeezed out so a CLI-made tag is
 * byte-identical to an app-made one and the two don't render as "two greens".
 */
export function resolveColor(input: string): string {
    const raw = (input ?? '').trim();
    if (!raw) throw new CliError(ExitCode.Validation, `Empty --color. ${colorHelp()}`);

    const named = TAG_COLORS[raw.toLowerCase()];
    if (named) return named;

    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return raw.toLowerCase();

    const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(raw);
    if (rgb) {
        const parts = [rgb[1], rgb[2], rgb[3]].map((n) => parseInt(n, 10));
        if (parts.some((n) => n > 255)) {
            throw new CliError(ExitCode.Validation, `Colour channel out of range in "${raw}" — each must be 0-255.`);
        }
        return `rgb(${parts.join(',')})`;
    }

    throw new CliError(ExitCode.Validation, `Unrecognised colour "${raw}". ${colorHelp()}`);
}

function colorHelp(): string {
    return `Use a name (${Object.keys(TAG_COLORS).join(', ')}), "#rrggbb", or "rgb(r,g,b)".`;
}

/**
 * Pick a colour from the tag's own name.
 *
 * Left to the server default, every tag an agent creates in one run would come
 * out the same grey, which defeats the point of a coloured label. Hashing the
 * name gives a spread that is also STABLE: the same tag name gets the same
 * colour in every brand, so "launch" looks like "launch" everywhere.
 */
export function autoColor(name: string): string {
    const key = name.trim().toLowerCase();
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
    return TAG_AUTO_COLORS[h % TAG_AUTO_COLORS.length];
}

/**
 * Quote a tag name for a copy-pasteable shell suggestion. Nested double quotes
 * ("ef tags create "black friday"") are not runnable, and JSON escaping is the
 * wrong dialect — a single-quoted argument is what a shell actually wants.
 */
export function shellQuote(name: string): string {
    return /^[\w.@/-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`;
}

/** Case-insensitive, whitespace-insensitive name match — how humans type tags. */
function sameName(a: string, b: string): boolean {
    return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/**
 * Find one tag by name or numeric id. Names are not unique server-side, so an
 * ambiguous name is an error rather than a coin toss — silently picking one
 * would attach the wrong colour and be invisible until someone looked.
 */
export function findTag(tags: BrandTag[], ref: string): BrandTag | null {
    const asId = /^\d+$/.test(ref.trim()) ? parseInt(ref.trim(), 10) : null;
    if (asId != null) return tags.find((t) => t.id === asId) ?? null;

    const matches = tags.filter((t) => sameName(t.name, ref));
    if (matches.length > 1) {
        throw new CliError(
            ExitCode.Validation,
            `"${ref}" matches ${matches.length} tags (#${matches.map((m) => m.id).join(', #')}). Pass the numeric id instead.`,
        );
    }
    return matches[0] ?? null;
}

/**
 * Resolve a target reference to a real record.
 *
 * A page VARIANT is retargeted to its parent: the dashboard only renders a
 * Tags column on parent rows (its list query excludes variants), so a tag on a
 * variant id is a row nobody can ever see. Tagging "the page" is what was
 * meant, so that is what happens — and the caller is told.
 */
export async function resolveTarget(api: ApiClient, brandId: number, raw: string): Promise<TagTarget> {
    const { kind, ref } = parseTargetRef(raw);

    if (kind === 'component') {
        const comp: Component = await resolveComponentByCodeOrName(api, brandId, ref);
        return { kind, moduleKey: TAGGABLE.component, id: comp.id, label: comp.code ?? comp.name ?? String(comp.id) };
    }

    let page: Page = await resolvePageBySlug(api, brandId, ref);
    if (page.parent_page_id != null) {
        const parent = (await api.listPages(brandId)).find((p) => p.id === page.parent_page_id);
        if (parent) {
            log.detail(`"${ref}" is a variant — tagging its parent page "${parent.slug ?? parent.id}" instead (that is the row the dashboard tags).`);
            page = parent;
        }
    }
    return { kind: 'page', moduleKey: TAGGABLE.page, id: page.id, label: page.slug ?? page.title ?? String(page.id) };
}

export interface AttachResult {
    attached: BrandTag[];
    created: BrandTag[];
    /** Already on the record — reported, not re-sent. */
    unchanged: BrandTag[];
}

/**
 * Put tags on a record, creating any that don't exist yet.
 *
 * The "already assigned" check is not an optimisation: the assign endpoint
 * inserts a join row unconditionally and nothing behind it is unique, so a
 * second attach would leave a duplicate that needs two detaches to clear.
 *
 * Shared with `ef pages create --tag` / `ef components create --tag`, which is
 * the point — tagging at creation time and tagging later must produce exactly
 * the same rows.
 */
export async function attachTags(
    api: ApiClient,
    brandId: number,
    target: TagTarget,
    names: string[],
    opts: { create?: boolean; color?: string } = {},
): Promise<AttachResult> {
    const wanted = dedupeNames(names);
    const result: AttachResult = { attached: [], created: [], unchanged: [] };
    if (!wanted.length) return result;

    // Scoped listing: every brand tag, each flagged with whether it's already
    // on this record. One request answers both "does it exist" and "is it on".
    let tags = await api.listTags(brandId, { moduleKey: target.moduleKey, itemId: target.id });

    for (const name of wanted) {
        let tag = findTag(tags, name);

        if (!tag) {
            if (opts.create === false) {
                throw new CliError(
                    ExitCode.NotFound,
                    `No tag "${name}" in this brand, and --no-create was passed. Create it with "ef tags create ${shellQuote(name)}".`,
                );
            }
            tag = await api.createTag(brandId, { name: name.trim(), color: opts.color ?? autoColor(name) });
            result.created.push(tag);
            tags = [...tags, tag]; // a repeat of the same name in this run reuses it
        } else if (isAssigned(tag)) {
            result.unchanged.push(tag);
            continue;
        }

        await api.assignTag(brandId, tag.id, { moduleKey: target.moduleKey, itemId: target.id });
        result.attached.push(tag);
    }

    return result;
}

/**
 * Take tags off a record.
 *
 * Loops while a tag still reads as assigned, because nothing stops the join
 * table holding duplicates (the app's own modal can create them) and one
 * unassign call deletes exactly one row. Bounded so a server that never stops
 * reporting `assigned` can't spin here.
 */
export async function detachTags(
    api: ApiClient,
    brandId: number,
    target: TagTarget,
    names: string[],
): Promise<{ detached: BrandTag[]; unchanged: string[] }> {
    const wanted = dedupeNames(names);
    const detached: BrandTag[] = [];
    const unchanged: string[] = [];
    if (!wanted.length) return { detached, unchanged };

    const scope = { moduleKey: target.moduleKey, itemId: target.id };
    let tags = await api.listTags(brandId, scope);

    for (const name of wanted) {
        const tag = findTag(tags, name);
        if (!tag) { unchanged.push(name); continue; }
        if (!isAssigned(tag)) { unchanged.push(tag.name); continue; }

        await api.unassignTag(brandId, tag.id, target.id);
        detached.push(tag);

        // Clear any duplicate join rows for the same pair.
        for (let pass = 0; pass < 4; pass++) {
            tags = await api.listTags(brandId, scope);
            const still = tags.find((t) => t.id === tag.id);
            if (!still || !isAssigned(still)) break;
            await api.unassignTag(brandId, tag.id, target.id);
        }
    }

    return { detached, unchanged };
}

/** `assigned` is `1`/`null` from the server's subquery — never a real boolean. */
function isAssigned(tag: BrandTag): boolean {
    return tag.assigned != null && tag.assigned !== false && tag.assigned !== 0;
}

/**
 * Commander collector for a repeatable `--tag`. Also splits on commas, because
 * `--tag a,b` is what people type and silently creating a tag literally named
 * "a,b" is the kind of mistake nobody notices until the list looks wrong.
 */
export function collectTag(value: string, previous?: string[]): string[] {
    // Commander passes `undefined` for the first occurrence when the option
    // carries no default — and giving it one just prints "(default: [])" in the
    // help for no benefit.
    return [...(previous ?? []), ...value.split(',').map((v) => v.trim()).filter(Boolean)];
}

/** Trim, drop blanks, and collapse repeats (case-insensitively) keeping first spelling. */
function dedupeNames(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names ?? []) {
        const name = (raw ?? '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

function printTags(rows: BrandTag[], opts: { json?: boolean; empty?: string }): void {
    if (opts.json) { log.json({ ok: true, tags: rows }); return; }
    if (!rows.length) { log.info(opts.empty ?? 'No tags in this brand yet.'); return; }
    log.raw(renderTable({
        head: ['id', 'name', 'colour'],
        rows: rows.map((t) => [String(t.id), t.name ?? '', colorLabel(t.color)]),
    }) + '\n');
}

/** Show the swatch name when the stored value is one of them; the raw CSS otherwise. */
export function colorLabel(color?: string | null): string {
    if (!color) return '';
    const name = Object.keys(TAG_COLORS).find((k) => TAG_COLORS[k] === color);
    return name ? `${name} (${color})` : color;
}

/** One-line summary of what an attach did — reused by `pages`/`components create`. */
export function summarizeAttach(res: AttachResult, target: TagTarget): string {
    const bits: string[] = [];
    if (res.attached.length) bits.push(`tagged ${res.attached.map((t) => c.bold(t.name)).join(', ')}`);
    if (res.unchanged.length) bits.push(`already had ${res.unchanged.map((t) => t.name).join(', ')}`);
    const created = res.created.length ? ` (created ${res.created.length} new tag${res.created.length === 1 ? '' : 's'})` : '';
    return `${target.kind} ${c.bold(target.label)}: ${bits.join('; ') || 'nothing to do'}${created}.`;
}

export function registerTagsCommand(program: Command): void {
    const cmd = program
        .command('tags')
        .alias('tag')
        .description('Coloured labels on pages and components — create them, and attach/detach them per record.')
        .addHelpText('after', `
A tag is a name + a colour, shared by the whole brand, shown in the dashboard's
Pages and Components lists. Those two lists are the only place tags are
VISIBLE, so those are the only two kinds this command tags.

  $ ef tags list                                    what exists
  $ ef tags attach pricing black-friday             tag a page (creates the tag if new)
  $ ef tags attach component:hero-banner q1-test    tag a component
  $ ef tags show pricing                            what's on one record
  $ ef tags detach pricing black-friday             take it off that record
  $ ef tags delete black-friday                     remove the tag from the BRAND
  $ ef list pages --tag black-friday                every page carrying it

TARGETS. A bare argument is a page slug (or page id). Prefix with
"component:" for a component code, name or id. Tagging a page variant tags its
parent — that is the row the dashboard shows a Tags column on.

ATTACH vs DELETE. "detach" takes a tag off one record and leaves the tag
alone. "delete" destroys the tag brand-wide and strips it from every record
that had it. They are not undo for each other.

COLOURS. Named swatches, matching the dashboard's picker:
  ${Object.entries(TAG_COLORS).map(([k, v]) => `${k.padEnd(7)} ${v}`).join('\n  ')}
"#rrggbb" and "rgb(r,g,b)" also work. Left unset, the colour is picked from the
tag's name, so a batch of new tags is distinguishable at a glance and the same
name always lands on the same colour.

TAGGING AT CREATION. Prefer this over a second pass — "ef pages create <slug>
--tag a --tag b" and "ef components create <code> --tag a" take the same names
and go through the same code path.`);

    cmd.command('list')
        .alias('ls')
        .description('List every tag in the brand.')
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const tags = await api.listTags(rt.config.brandId);
            printTags(tags, {
                json: opts.json,
                empty: 'No tags in this brand yet. Create one with "ef tags create <name>", or just attach one — "ef tags attach <page> <name>" makes it.',
            });
            if (!opts.json && tags.length) log.detail(`${tags.length} tags`);
        });

    cmd.command('create <name>')
        .alias('new')
        .description('Create a tag without attaching it to anything.')
        .option('--color <colour>', 'Swatch name, "#rrggbb" or "rgb(r,g,b)". Default: picked from the name.')
        .option('--json', 'Print the tag as JSON.')
        .action(async (name: string, opts: { color?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const color = opts.color ? resolveColor(opts.color) : autoColor(name);

            const existing = findTag(await api.listTags(rt.config.brandId), name);
            if (existing) {
                throw new CliError(
                    ExitCode.Validation,
                    `A tag named "${existing.name}" already exists (#${existing.id}). Recolour it with "ef tags update ${existing.id} --color <colour>".`,
                );
            }

            const tag = await api.createTag(rt.config.brandId, { name: name.trim(), color });
            if (opts.json) { log.json({ ok: true, tag }); return; }
            log.success(`Created tag ${c.bold(tag.name)} (#${tag.id}) — ${colorLabel(tag.color)}.`);
            log.detail(`Put it on something with "ef tags attach <page-slug> ${shellQuote(tag.name)}".`);
        });

    cmd.command('update <nameOrId>')
        .description('Rename or recolour a tag. Every record carrying it follows.')
        .option('--name <name>', 'New name.')
        .option('--color <colour>', 'New colour — swatch name, "#rrggbb" or "rgb(r,g,b)".')
        .option('--json', 'Print the tag as JSON.')
        .action(async (ref: string, opts: { name?: string; color?: string; json?: boolean }) => {
            if (!opts.name && !opts.color) {
                throw new CliError(ExitCode.Validation, 'Nothing to change — pass --name and/or --color.');
            }
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const tag = requireTag(findTag(await api.listTags(rt.config.brandId), ref), ref);

            // The server requires BOTH fields on update, so unchanged ones are
            // re-sent as they are rather than blanked.
            const updated = await api.updateTag(rt.config.brandId, tag.id, {
                name: (opts.name ?? tag.name).trim(),
                color: opts.color ? resolveColor(opts.color) : (tag.color ?? autoColor(tag.name)),
            });
            if (opts.json) { log.json({ ok: true, tag: updated }); return; }
            log.success(`Updated tag #${tag.id} → ${c.bold(updated.name ?? tag.name)} (${colorLabel(updated.color)}).`);
        });

    cmd.command('delete <nameOrId>')
        .description('Delete a tag from the BRAND, stripping it from every record. To take it off one record, use "ef tags detach".')
        .option('--force', 'Skip the confirmation prompt.')
        .option('--json', 'Print the result as JSON.')
        .action(async (ref: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const tag = requireTag(findTag(await api.listTags(rt.config.brandId), ref), ref);

            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete tag "${tag.name}" (#${tag.id}) from the whole brand?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }

            await api.deleteTag(rt.config.brandId, tag.id);
            if (opts.json) { log.json({ ok: true, deleted: { id: tag.id, name: tag.name } }); return; }
            log.success(`Deleted tag ${c.bold(tag.name)} (#${tag.id}) and every assignment of it.`);
        });

    cmd.command('show <target>')
        .description('Show the tags on one record. <target> is a page slug/id, or "component:<code>".')
        .option('--all', 'Also list the brand tags NOT on this record.')
        .option('--json', 'Print as JSON.')
        .action(async (targetRef: string, opts: { all?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const target = await resolveTarget(api, rt.config.brandId, targetRef);
            const tags = await api.listTags(rt.config.brandId, { moduleKey: target.moduleKey, itemId: target.id });
            const on = tags.filter(isAssigned);
            const off = tags.filter((t) => !isAssigned(t));

            if (opts.json) {
                log.json({ ok: true, target, tags: on, ...(opts.all ? { available: off } : {}) });
                return;
            }
            log.info(`${target.kind} ${c.bold(target.label)} (#${target.id})`);
            if (!on.length) {
                log.detail('  no tags');
            } else {
                printTags(on, {});
            }
            if (opts.all) {
                log.info('');
                if (!tags.length) {
                    log.detail('This brand has no tags yet — "ef tags attach <target> <name>" makes one.');
                } else if (!off.length) {
                    log.detail(`Every brand tag is already on this ${target.kind}.`);
                } else {
                    log.detail(`Also in this brand, not on this ${target.kind}:`);
                    printTags(off, {});
                }
            }
        });

    cmd.command('attach <target> <tags...>')
        .alias('add')
        .description('Put one or more tags on a page or component, creating any that don\'t exist yet.')
        .option('--no-create', 'Fail instead of creating a tag that doesn\'t exist.')
        .option('--color <colour>', 'Colour for tags created by this call. Default: picked from each name.')
        .option('--json', 'Print the result as JSON.')
        .action(async (targetRef: string, names: string[], opts: { create?: boolean; color?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const target = await resolveTarget(api, rt.config.brandId, targetRef);
            const res = await attachTags(api, rt.config.brandId, target, names, {
                create: opts.create,
                color: opts.color ? resolveColor(opts.color) : undefined,
            });
            if (opts.json) { log.json({ ok: true, target, ...res }); return; }
            log.success(summarizeAttach(res, target));
        });

    cmd.command('detach <target> <tags...>')
        .alias('remove')
        .description('Take one or more tags off a page or component. The tags themselves stay in the brand.')
        .option('--json', 'Print the result as JSON.')
        .action(async (targetRef: string, names: string[], opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const target = await resolveTarget(api, rt.config.brandId, targetRef);
            const res = await detachTags(api, rt.config.brandId, target, names);
            if (opts.json) { log.json({ ok: true, target, ...res }); return; }
            if (res.detached.length) {
                log.success(`${target.kind} ${c.bold(target.label)}: removed ${res.detached.map((t) => c.bold(t.name)).join(', ')}.`);
            }
            if (res.unchanged.length) {
                log.detail(`Not on this ${target.kind}: ${res.unchanged.join(', ')}.`);
            }
            if (!res.detached.length && !res.unchanged.length) log.info('Nothing to do.');
        });
}

function requireTag(tag: BrandTag | null, ref: string): BrandTag {
    if (!tag) throw new CliError(ExitCode.NotFound, `No tag "${ref}" in this brand. Run "ef tags list".`);
    return tag;
}
