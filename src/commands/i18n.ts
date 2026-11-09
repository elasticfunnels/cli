// Multilingual sites (T1031-3): `ef i18n check|synced|settings`, `ef translations pull|push`, and the
// translation subcommands of `ef pages` and `ef components`.
//
// Two models, both supported by the runtime:
//   - linked pages: one page per language (own slug, HTML, SEO), linked to a source page;
//   - dictionary pages: one page for all languages, its text in t('key') / data-ef-hl, served under
//     /<prefix>/<slug> when the brand turns on prefix routing.
import { ownLanguageHeadTags } from '../utils/languageHeadTags';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Component, Page } from '../api/types';
import {
    bulkSaveEntries, createLanguage, createTranslation, deleteEntry, getI18nSettings, I18nSettings, listEntries,
    listLanguages, listTranslations, markSynced, normalizeLanguageCode, PromptMode, putI18nSettings,
    TranslatableKind, TranslationLanguage, TranslationMember, updateLanguage,
} from '../api/i18nApi';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { renderTable } from '../utils/format';
import { EfRuntime, loadRuntime } from '../utils/store';
import { fileExists, writeFileAtomic } from '../utils/fs';
import { safeJoinBrandRoot } from '../sync/paths';
import { parseEfMeta } from '../sync/efMeta';
import { SyncStateFile } from '../sync/stateFile';
import { buildSyncContext, pullComponent, pullPage } from '../sync/sync';
import { parseLangFlag } from '../sync/pageI18n';
import { translationSourceHash } from '../utils/textHash';
import { resolveAnyPageId } from './pageGet';
import { resolveComponentByCodeOrName } from './shared';

// ── Shared ───────────────────────────────────────────────────────────

function apiFor(rt: EfRuntime): ApiClient { return new ApiClient(rt.config.apiUrl, rt.apiKey); }

function requireLang(v: string | undefined, flag = '--lang'): string {
    if (v === undefined) throw new CliError(ExitCode.Validation, `${flag} <code> is required (for example ${flag} ro).`);
    const code = parseLangFlag(v);
    if (!code) throw new CliError(ExitCode.Validation, `${flag} needs a language code here, not "none".`);
    return code;
}

function collectList(v: string, prev: string[] = []): string[] {
    return prev.concat(v.split(',').map(s => s.trim()).filter(Boolean));
}

function staleLabel(stale: boolean | null | undefined, isSource: boolean): string {
    if (isSource) return 'source';
    if (stale === true) return c.yellow('stale');
    if (stale === false) return 'up to date';
    return '-';
}

function printMembers(kind: TranslatableKind, members: TranslationMember[]): void {
    if (members.length === 0) { log.info('No translations: this one is not in a translation group yet.'); return; }
    const sorted = [...members].sort((a, b) => Number(b.is_source) - Number(a.is_source) || String(a.language).localeCompare(String(b.language)));
    log.info(renderTable({
        head: kind === 'page' ? ['ID', 'LANGUAGE', 'SLUG', 'STATUS', 'TRANSLATION', 'URL'] : ['ID', 'LANGUAGE', 'CODE', 'TRANSLATION'],
        rows: sorted.map(m => kind === 'page'
            ? [String(m.id), m.language ?? '(not set)', m.slug ?? '', m.status ?? '', staleLabel(m.stale, m.is_source), m.url ?? '']
            : [String(m.id), m.language ?? '(base)', m.code ?? m.slug ?? '', staleLabel(m.stale, m.is_source)]),
        maxCellWidth: 90,
    }));
}

async function resolveTarget(api: ApiClient, brandId: number, kind: TranslatableKind, ref: string): Promise<{ id: number; label: string }> {
    if (kind === 'page') {
        const { id, all } = await resolveAnyPageId(api, brandId, ref);
        return { id, label: all.find(p => p.id === id)?.slug ?? ref };
    }
    const comp = await resolveComponentByCodeOrName(api, brandId, ref);
    return { id: comp.id, label: comp.code ?? comp.name ?? ref };
}

// ── ef pages translate / translations, ef components translate / translations ──

export function registerTranslationSubcommands(parent: Command, kind: TranslatableKind): void {
    const noun = kind === 'page' ? 'page' : 'component';
    const refArg = kind === 'page' ? '<slug>' : '<code>';

    const translate = parent.command(`translate ${refArg}`)
        .description(kind === 'page'
            ? 'Make a translation of a page: clone its source page into another language, linked to it, and pull it.'
            : 'Make a translation of a component: a copy in another language that pages in that language use instead of the base.')
        .option('--lang <code>', 'Language of the new translation (a brand language, see "ef translations pull").');
    if (kind === 'page') {
        translate
            .option('--slug <slug>', 'Slug of the new page. Default: <language prefix>/<source slug> ("ro/about"; the index page becomes "ro/index").')
            .option('--title <title>', 'Title of the new page. Default: the source title.');
    } else {
        translate
            .option('--code <code>', 'Code of the new component. Default: chosen by the server from the source code and language.')
            .option('--name <name>', 'Display name. Default: the source name.');
    }
    translate
        .option('--no-copy', 'Start empty instead of copying the source content.')
        .option('--no-pull', 'Do not pull the new translation to disk.')
        .option('--json', 'Print the result as JSON.')
        .addHelpText('after', kind === 'page' ? `
The new page is its own page: own slug, HTML, SEO fields, revisions and split
tests. The source stays as it is. Translate the copy, then push it:

  $ ef pages translate about --lang ro          # creates ro/about, pulls pages/ro/about.ef
  $ ef pages translate index --lang pt-br --slug pt-br/inicio --title "Início"

Both pages then link to each other: hreflang tags, the sitemap and the
language switcher pick it up once it is published. When the source changes
later, "ef i18n check" lists the translation as stale until you update it and
run "ef i18n synced ro/about".` : `
A page in a language uses that language's translation of each component it
includes, and the base component when there is none. Keep one component with
t('key') texts instead when only the words differ.

  $ ef components translate header --lang ro`)
        .action(async (ref: string, opts: { lang?: string; slug?: string; title?: string; code?: string; name?: string; copy?: boolean; pull?: boolean; json?: boolean }) => {
            const language = requireLang(opts.lang);
            const rt = await loadRuntime();
            const api = apiFor(rt);
            const target = await resolveTarget(api, rt.config.brandId, kind, ref);
            const payload: Record<string, unknown> = { language };
            if (opts.slug !== undefined) payload.slug = opts.slug.replace(/^\/+/, '');
            if (opts.title !== undefined) payload.title = opts.title;
            if (opts.code !== undefined) payload.code = opts.code;
            if (opts.name !== undefined) payload.name = opts.name;
            if (opts.copy === false) payload.copy_content = false;
            const created = await createTranslation(api, rt.config.brandId, kind, target.id, payload as { language: string });
            let pulled: string | null = null;
            if (opts.pull !== false && created?.id) {
                const ctx = await buildSyncContext(rt);
                try {
                    const r = kind === 'page' ? await pullPage(ctx, created.id) : await pullComponent(ctx, created.id);
                    pulled = r.rel;
                    await ctx.state.save();
                } catch (err) {
                    // Builder pages do not sync as .ef files; the translation exists either way.
                    log.warn(`Created, but not pulled: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (opts.json) { log.json({ ok: true, kind, source: target, translation: created, pulled }); return; }
            const label = kind === 'page' ? (created.slug ?? '?') : (created.code ?? created.name ?? '?');
            log.success(`Created ${noun} #${created.id} "${label}" in ${language}, a translation of ${target.label}.`);
            if (pulled) log.detail(`  Pulled to ${pulled}. Translate it, then "ef push ${pulled}".`);
        });

    parent.command(`translations ${refArg}`)
        .description(`List every language version of a ${noun} (its translation group), with the stale flag.`)
        .option('--json', 'Print rows as JSON.')
        .addHelpText('after', `
"stale" means the source changed after the translation was made or last
marked up to date. Update the translation, then "ef i18n synced <${kind === 'page' ? 'slug' : 'code'}>".`)
        .action(async (ref: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = apiFor(rt);
            const target = await resolveTarget(api, rt.config.brandId, kind, ref);
            const members = await listTranslations(api, rt.config.brandId, kind, target.id);
            if (opts.json) { log.json({ ok: true, kind, id: target.id, translations: members }); return; }
            printMembers(kind, members);
        });
}

// ── ef i18n ──────────────────────────────────────────────────────────

interface Row { id: number; ref: string; language: string | null; sourceId: number | null; stale: boolean | null; sourceHash: string | null }

interface GroupReport {
    kind: TranslatableKind;
    source: { id: number; ref: string; language: string | null };
    languages: Array<{ language: string; id: number; ref: string; stale: boolean | null }>;
    missing: string[];
    stale: Array<{ id: number; ref: string; language: string | null }>;
    /** Translations that will turn stale once the source's local, unpushed edits are pushed. */
    staleAfterPush: Array<{ id: number; ref: string; language: string | null }>;
}

function rowsFromPages(pages: Page[]): Row[] {
    // Variants share their parent's slug and language; the parent stands for the family.
    return pages.filter(p => p.parent_page_id == null).map(p => ({
        id: p.id, ref: p.slug ?? String(p.id), language: p.language ?? null, sourceId: p.translation_source_id ?? null,
        stale: p.translation_stale ?? null, sourceHash: p.translation_source_hash ?? null,
    }));
}

function rowsFromComponents(list: Component[]): Row[] {
    return list.map(x => ({
        id: x.id, ref: x.code ?? x.name ?? String(x.id), language: x.language ?? null, sourceId: x.translation_source_id ?? null,
        stale: x.translation_stale ?? null, sourceHash: x.translation_source_hash ?? null,
    }));
}

/**
 * Group rows by `translation_source_id ?? id` and report missing and stale languages. A group counts when
 * any member has a language or a translation; a source page without a language stands for the default one.
 */
export function buildReport(
    kind: TranslatableKind,
    rows: Row[],
    targetLanguages: string[],
    defaultLanguage: string | null,
    localSourceHash: (id: number) => string | null,
    opts: { includeUntranslated?: boolean } = {},
): GroupReport[] {
    const groups = new Map<number, Row[]>();
    for (const r of rows) {
        const key = r.sourceId ?? r.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
    }
    const out: GroupReport[] = [];
    for (const [key, members] of groups) {
        const source = members.find(m => m.id === key) ?? rows.find(r => r.id === key);
        const translations = members.filter(m => m.sourceId != null);
        if (!source) continue;
        if (translations.length === 0 && !source.language) continue;
        // A tagged page with no translation at all is a page you chose not to translate (a
        // partly translated site), not a gap: it counts only with --untranslated.
        if (translations.length === 0 && !opts.includeUntranslated) continue;
        const langs = new Map<string, Row>();
        const srcLang = source.language ?? defaultLanguage;
        if (srcLang) langs.set(srcLang, source);
        for (const t of translations) if (t.language) langs.set(t.language, t);
        const localHash = localSourceHash(source.id);
        out.push({
            kind,
            source: { id: source.id, ref: source.ref, language: source.language },
            languages: [...langs.entries()].map(([language, r]) => ({ language, id: r.id, ref: r.ref, stale: r.id === source.id ? null : r.stale })),
            missing: targetLanguages.filter(l => !langs.has(l)),
            stale: translations.filter(t => t.stale === true).map(t => ({ id: t.id, ref: t.ref, language: t.language })),
            staleAfterPush: localHash
                ? translations.filter(t => t.stale !== true && t.sourceHash && t.sourceHash !== localHash).map(t => ({ id: t.id, ref: t.ref, language: t.language }))
                : [],
        });
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.source.ref.localeCompare(b.source.ref));
}

/** Hash of a source's LOCAL file (unpushed edits included), using the server's SEO fields. */
async function localHashReader(rt: EfRuntime, kind: TranslatableKind, byId: Map<number, Page | Component>): Promise<(id: number) => string | null> {
    const state = await SyncStateFile.load(rt.brandRoot, rt.config.brandId);
    const bucket = kind === 'page' ? state.pages() : state.components();
    const pathById = new Map<number, string>();
    for (const e of Object.values(bucket)) pathById.set(e.id, e.path);
    const cache = new Map<number, string | null>();
    return (id: number) => {
        if (cache.has(id)) return cache.get(id)!;
        let hash: string | null = null;
        const rel = pathById.get(id);
        if (rel) {
            try {
                const abs = safeJoinBrandRoot(rt.brandRoot, rel);
                const { body } = parseEfMeta(fs.readFileSync(abs, 'utf8'));
                const entity = byId.get(id) as Partial<Page> | undefined;
                hash = translationSourceHash({
                    seo_title: kind === 'page' ? entity?.seo_title : '',
                    seo_description: kind === 'page' ? entity?.seo_description : '',
                    html: body,
                });
            } catch { hash = null; }
        }
        cache.set(id, hash);
        return hash;
    };
}

/** Pages with a language whose local file keeps its own hreflang / canonical / og:locale (EF steps back for those). */
async function pagesWithOwnHeadTags(rt: EfRuntime, pages: Page[]): Promise<Array<{ slug: string; language: string; tags: string[] }>> {
    const state = await SyncStateFile.load(rt.brandRoot, rt.config.brandId);
    const pathById = new Map<number, string>();
    for (const e of Object.values(state.pages())) pathById.set(e.id, e.path);
    const out: Array<{ slug: string; language: string; tags: string[] }> = [];
    for (const p of pages) {
        const language = (p as Partial<Page> & { language?: string | null }).language;
        const rel = pathById.get(p.id);
        if (!language || !rel) continue;
        try {
            const { body } = parseEfMeta(fs.readFileSync(safeJoinBrandRoot(rt.brandRoot, rel), 'utf8'));
            const tags = ownLanguageHeadTags(body);
            if (tags.length) out.push({ slug: String((p as Partial<Page>).slug ?? p.id), language, tags });
        } catch { /* not pulled: nothing to check */ }
    }
    return out;
}

export function registerI18nCommand(program: Command): void {
    const cmd = program
        .command('i18n')
        .description('Multilingual sites: check translations (missing, stale), mark one up to date, brand language settings.')
        .addHelpText('after', `
Two ways to make a site multilingual, and a brand can use both:

  Linked pages   One page per language, each with its own slug, HTML and SEO,
                 linked to a source page ("ef pages translate about --lang ro").
                 Best when the layout or the offer differs per language.
  Dictionary     One page for all languages; its words live in the brand
                 dictionary as t('key') / data-ef-hl ("ef translations pull").
                 With prefix routing on, /ro/about serves that page in Romanian.

Either way the page gets <html lang>, hreflang alternates, sitemap alternates,
and the language switcher and suggestion prompt can link the versions.

Docs: https://docs.elasticfunnels.io/pages/internationalization`);

    cmd.command('check')
        .description('List missing translations per group and stale ones (source changed since). Exits 1 when any is stale.')
        .option('--lang <codes>', 'Only these languages (comma list or repeat). Default: every brand language.', collectList)
        .option('--pages', 'Pages only.')
        .option('--components', 'Components only.')
        .option('--untranslated', 'Also list pages and components with a language but no translation yet (missing every other language).')
        .option('--strict', 'Also exit 1 when a translation is missing, or a page with a language keeps its own hreflang, canonical or og:locale.')
        .option('--json', 'Print the report as JSON.')
        .addHelpText('after', `
A translation is stale when its source's text (SEO title, SEO description and
visible text) changed after the translation was made or last marked up to
date. The CLI uses the same hash as the app. It also reads the source's local
file, so a source edit you have not pushed yet shows as "stale after push".

Use it as a publish gate:
  $ ef i18n check --lang ro,es && ef push --all

Exit codes: 0 nothing stale, 1 something stale (or missing with --strict).`)
        .action(async (opts: { lang?: string[]; pages?: boolean; components?: boolean; strict?: boolean; untranslated?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = apiFor(rt);
            const brandId = rt.config.brandId;
            const languages = await listLanguages(api, brandId);
            const defaultLanguage = languages.find(l => l.is_default)?.code ?? null;
            const targets = opts.lang?.length ? opts.lang.map(normalizeLanguageCode).filter(Boolean) : languages.map(l => l.code);
            const unknown = targets.filter(t => !languages.some(l => l.code === t));
            if (unknown.length && languages.length) log.warn(`Not a brand language: ${unknown.join(', ')}. Add it in Pages > Translations, or in translations/<code>.json and "ef translations push".`);
            const wantPages = opts.pages || !opts.components;
            const wantComponents = opts.components || !opts.pages;

            const report: GroupReport[] = [];
            let ownHeadTags: Array<{ slug: string; language: string; tags: string[] }> = [];
            if (wantPages) {
                const pages = await api.listPages(brandId, 100000, { allTypes: true });
                const byId = new Map<number, Page>(pages.map(p => [p.id, p]));
                report.push(...buildReport('page', rowsFromPages(pages), targets, defaultLanguage, await localHashReader(rt, 'page', byId), { includeUntranslated: opts.untranslated }));
                ownHeadTags = await pagesWithOwnHeadTags(rt, pages);
            }
            if (wantComponents) {
                const comps = await api.listComponents(brandId);
                const byId = new Map<number, Component>(comps.map(x => [x.id, x]));
                report.push(...buildReport('component', rowsFromComponents(comps), targets, defaultLanguage, await localHashReader(rt, 'component', byId), { includeUntranslated: opts.untranslated }));
            }
            const stale = report.reduce((n, g) => n + g.stale.length, 0);
            const missing = report.reduce((n, g) => n + g.missing.length, 0);
            const staleAfterPush = report.reduce((n, g) => n + g.staleAfterPush.length, 0);
            if (stale > 0 || (opts.strict && (missing > 0 || ownHeadTags.length > 0))) process.exitCode = ExitCode.Error;

            if (opts.json) {
                log.json({ ok: stale === 0 && !(opts.strict && (missing > 0 || ownHeadTags.length > 0)), languages: targets, default_language: defaultLanguage, summary: { groups: report.length, stale, missing, stale_after_push: staleAfterPush, own_head_tags: ownHeadTags.length }, groups: report, own_head_tags: ownHeadTags });
                return;
            }
            for (const o of ownHeadTags) {
                log.warn(`pages/${o.slug} (${o.language}) has its own ${o.tags.join(', ')}: EF writes these for pages with a language and steps back when the page declares them. Remove them unless you mean to override.`);
            }
            if (report.length === 0) {
                log.info('No translated pages or components yet. Start with "ef pages translate <slug> --lang <code>" or "ef pages settings <slug> --lang <code>".');
                return;
            }
            const rows: string[][] = [];
            for (const g of report) {
                const parts: string[] = [];
                for (const l of g.languages) {
                    const isStale = g.stale.some(s => s.id === l.id);
                    const after = g.staleAfterPush.some(s => s.id === l.id);
                    parts.push(isStale ? c.yellow(`${l.language} stale`) : after ? c.yellow(`${l.language} stale after push`) : l.language);
                }
                rows.push([g.kind, g.source.ref, parts.join(', '), g.missing.length ? c.red(g.missing.join(', ')) : '-']);
            }
            log.info(renderTable({ head: ['KIND', 'SOURCE', 'LANGUAGES', 'MISSING'], rows, maxCellWidth: 70 }));
            const summary = `${report.length} group${report.length === 1 ? '' : 's'}, ${stale} stale, ${missing} missing${staleAfterPush ? `, ${staleAfterPush} stale after push` : ''}.`;
            if (stale > 0) log.warn(`${summary} Update the stale translations, then "ef i18n synced <slug>".`);
            else log.success(summary);
        });

    cmd.command('synced <slugOrCode>')
        .description('Mark a translation up to date with its source (after you updated its text).')
        .option('--component', 'The argument is a component code, not a page slug.')
        .option('--json', 'Print the result as JSON.')
        .action(async (ref: string, opts: { component?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = apiFor(rt);
            const kind: TranslatableKind = opts.component ? 'component' : 'page';
            const target = await resolveTarget(api, rt.config.brandId, kind, ref);
            const res = await markSynced(api, rt.config.brandId, kind, target.id);
            if (opts.json) { log.json({ ok: true, kind, id: target.id, response: res }); return; }
            log.success(`Marked ${target.label} up to date with its source.`);
        });

    cmd.command('settings')
        .description('Show or change the brand\'s multilingual settings: prefix routing, the language prompt, x-default.')
        .option('--prefix-routing <on|off>', 'Serve dictionary pages under /<prefix>/<slug> (for example /ro/about).')
        .option('--prompt <mode>', 'Language suggestion prompt: off | default (EF\'s small modal) | custom (your markup, EF logic).')
        .option('--x-default <code>', 'Language for hreflang="x-default"; "none" uses the default language.')
        .option('--json', 'Print the settings as JSON.')
        .addHelpText('after', `
  $ ef i18n settings                                 # show
  $ ef i18n settings --prefix-routing on --prompt custom
  $ ef i18n settings --x-default en

The prompt suggests a visitor's language when the page exists in it. It never
redirects on its own, never shows to bots, and asks once per visitor. With
"custom", put your own markup on the page (data-ef-lang-modal) or drive it
from window.ef.i18n. Language prefixes are set per language ("url_prefix" in
translations/<code>.json).

A domain per language (fully translated sites): bind a domain to a language
and it serves each linked page in that language at the original's slug:
  $ ef domains language example.ro ro          (see "ef domains language --help")`)
        .action(async (opts: { prefixRouting?: string; prompt?: string; xDefault?: string; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = apiFor(rt);
            const current = await getI18nSettings(api, rt.config.brandId);
            const next: I18nSettings = { ...current };
            if (opts.prefixRouting !== undefined) next.prefix_routing = onOff(opts.prefixRouting, '--prefix-routing');
            if (opts.prompt !== undefined) {
                const p = opts.prompt.trim().toLowerCase();
                if (p !== 'off' && p !== 'default' && p !== 'custom') throw new CliError(ExitCode.Validation, `--prompt takes off, default or custom (got "${opts.prompt}").`);
                next.prompt = p as PromptMode;
            }
            if (opts.xDefault !== undefined) next.x_default = parseLangFlag(opts.xDefault);
            const changed = opts.prefixRouting !== undefined || opts.prompt !== undefined || opts.xDefault !== undefined;
            const saved = changed ? await putI18nSettings(api, rt.config.brandId, next) : current;
            if (opts.json) { log.json({ ok: true, changed, settings: saved }); return; }
            if (changed) log.success('Saved the multilingual settings.');
            log.info(`  Prefix routing  ${saved.prefix_routing ? 'on' : 'off'}`);
            log.info(`  Prompt          ${saved.prompt}`);
            log.info(`  x-default       ${saved.x_default ?? '(default language)'}`);
        });
}

function onOff(v: string, flag: string): boolean {
    const t = v.trim().toLowerCase();
    if (['on', 'true', 'yes', '1'].includes(t)) return true;
    if (['off', 'false', 'no', '0'].includes(t)) return false;
    throw new CliError(ExitCode.Validation, `${flag} takes on or off (got "${v}").`);
}

// ── ef translations pull | push ──────────────────────────────────────

/** translations/<code>.json */
export interface DictionaryFile {
    language: { code: string; label: string | null; is_default: boolean; sort_order?: number | null; url_prefix?: string | null };
    entries: Record<string, string>;
}

const DICT_DIR = 'translations';

export function dictionaryFileFor(lang: TranslationLanguage, entries: Array<{ key: string; value: string | null }>): DictionaryFile {
    const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    const map: Record<string, string> = {};
    for (const e of sorted) map[e.key] = e.value ?? '';
    return {
        language: {
            code: lang.code,
            label: lang.label ?? null,
            is_default: Boolean(lang.is_default),
            sort_order: lang.sort_order ?? 0,
            url_prefix: lang.url_prefix ?? null,
        },
        entries: map,
    };
}

export function parseDictionaryFile(text: string, file: string): DictionaryFile {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (err) {
        throw new CliError(ExitCode.Validation, `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const o = raw as Partial<DictionaryFile>;
    const code = normalizeLanguageCode(String(o?.language?.code ?? path.basename(file, '.json')));
    if (!code) throw new CliError(ExitCode.Validation, `${file}: language.code is missing.`);
    if (o.entries != null && (typeof o.entries !== 'object' || Array.isArray(o.entries))) {
        throw new CliError(ExitCode.Validation, `${file}: "entries" must be an object of key: text.`);
    }
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.entries ?? {})) {
        if (typeof v !== 'string') throw new CliError(ExitCode.Validation, `${file}: the text for "${k}" must be a string.`);
        entries[k] = v;
    }
    const prefix = o.language?.url_prefix;
    if (prefix != null && prefix !== '' && !/^[a-z0-9-]{1,32}$/.test(prefix)) {
        throw new CliError(ExitCode.Validation, `${file}: url_prefix must be lowercase letters, digits and dashes, no slashes (got "${prefix}").`);
    }
    return {
        language: {
            code,
            label: o.language?.label ?? null,
            is_default: Boolean(o.language?.is_default),
            sort_order: o.language?.sort_order ?? undefined,
            url_prefix: prefix === undefined ? undefined : (prefix === '' ? null : prefix),
        },
        entries,
    };
}

export function registerTranslationsCommand(program: Command): void {
    const cmd = program
        .command('translations')
        .description('The brand dictionary (t(\'key\') and data-ef-hl texts): pull to translations/<code>.json and push back.')
        .addHelpText('after', `
One file per language, under the brand folder:

  translations/ro.json
  {
    "language": { "code": "ro", "label": "Română", "is_default": false, "sort_order": 1, "url_prefix": null },
    "entries": { "hero.title": "Zile bune", "nav.home": "Acasă" }
  }

"label" is what the language switcher shows: write it in its own language.
"url_prefix" is the path prefix for prefix routing; null means "" for the
default language and the code for the others.

A missing text falls back to the default language, so a key only needs a value
in the languages where it differs.`);

    cmd.command('pull')
        .description('Write every brand language and its texts to translations/<code>.json.')
        .option('--lang <codes>', 'Only these languages (comma list or repeat).', collectList)
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: { lang?: string[]; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = apiFor(rt);
            const languages = await listLanguages(api, rt.config.brandId);
            const only = opts.lang?.map(normalizeLanguageCode);
            const written: Array<{ code: string; file: string; entries: number }> = [];
            for (const lang of languages) {
                if (only && !only.includes(lang.code)) continue;
                const entries = await listEntries(api, rt.config.brandId, lang.id);
                const rel = `${DICT_DIR}/${lang.code}.json`;
                const abs = safeJoinBrandRoot(rt.brandRoot, rel);
                await fs.promises.mkdir(path.dirname(abs), { recursive: true });
                await writeFileAtomic(abs, JSON.stringify(dictionaryFileFor(lang, entries), null, 2) + '\n');
                written.push({ code: lang.code, file: rel, entries: entries.length });
            }
            if (opts.json) { log.json({ ok: true, files: written }); return; }
            if (written.length === 0) { log.info('The brand has no languages yet. Create translations/<code>.json and run "ef translations push".'); return; }
            for (const w of written) log.info(`  ${c.green('pulled')} ${w.file} (${w.entries} text${w.entries === 1 ? '' : 's'})`);
        });

    cmd.command('push [files...]')
        .description('Send translations/<code>.json files: create or update the language, upsert its texts.')
        .option('--prune', 'Also delete texts on the server that the file no longer has.')
        .option('--dry-run', 'Show what would change without writing.')
        .option('--json', 'Print the result as JSON.')
        .addHelpText('after', `
  $ ef translations push                    # every file in translations/
  $ ef translations push translations/ro.json
  $ ef translations push --prune            # make the server match the files exactly

Without --prune nothing is deleted: a key missing from the file is left alone.`)
        .action(async (files: string[], opts: { prune?: boolean; dryRun?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = apiFor(rt);
            const brandId = rt.config.brandId;
            const dir = safeJoinBrandRoot(rt.brandRoot, DICT_DIR);
            let targets: string[] = files ?? [];
            if (targets.length === 0) {
                if (!(await fileExists(dir))) throw new CliError(ExitCode.NotFound, `No ${DICT_DIR}/ folder. Run "ef translations pull" first.`);
                targets = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));
            }
            const parsed: Array<{ file: string; dict: DictionaryFile }> = [];
            for (const t of targets) {
                const abs = path.isAbsolute(t) ? t : (await fileExists(path.resolve(t)) ? path.resolve(t) : safeJoinBrandRoot(rt.brandRoot, t));
                parsed.push({ file: path.relative(rt.brandRoot, abs), dict: parseDictionaryFile(await fs.promises.readFile(abs, 'utf8'), abs) });
            }
            const defaults = parsed.filter(p => p.dict.language.is_default);
            if (defaults.length > 1) throw new CliError(ExitCode.Validation, `More than one file says is_default: ${defaults.map(d => d.file).join(', ')}.`);

            const languages = await listLanguages(api, brandId);
            const results: Array<Record<string, unknown>> = [];
            for (const { file, dict } of parsed) {
                const lang = dict.language;
                let existing = languages.find(l => l.code === lang.code);
                const langPayload: Record<string, unknown> = { code: lang.code, label: lang.label, is_default: lang.is_default };
                if (lang.sort_order != null) langPayload.sort_order = lang.sort_order;
                if (lang.url_prefix !== undefined) langPayload.url_prefix = lang.url_prefix;
                let languageAction = 'unchanged';
                if (!existing) {
                    languageAction = 'created';
                    if (!opts.dryRun) existing = await createLanguage(api, brandId, langPayload);
                } else if (
                    (existing.label ?? null) !== (lang.label ?? null) || Boolean(existing.is_default) !== lang.is_default
                    || (lang.sort_order != null && (existing.sort_order ?? 0) !== lang.sort_order)
                    || (lang.url_prefix !== undefined && (existing.url_prefix ?? null) !== (lang.url_prefix ?? null))
                ) {
                    languageAction = 'updated';
                    if (!opts.dryRun) existing = await updateLanguage(api, brandId, existing.id, langPayload);
                }
                const server = existing?.id ? await listEntries(api, brandId, existing.id) : [];
                const serverMap = new Map(server.map(e => [e.key, e]));
                const upserts = Object.entries(dict.entries)
                    .filter(([k, v]) => (serverMap.get(k)?.value ?? null) !== v)
                    .map(([key, value]) => ({ key, value }));
                const removals = opts.prune ? server.filter(e => !(e.key in dict.entries)) : [];
                let saved = { created: 0, updated: 0, skipped: 0 };
                if (!opts.dryRun && existing?.id) {
                    if (upserts.length) saved = await bulkSaveEntries(api, brandId, existing.id, upserts);
                    for (const r of removals) await deleteEntry(api, brandId, r.id);
                }
                results.push({
                    file, code: lang.code, language: languageAction,
                    texts: opts.dryRun ? { changed: upserts.length } : saved,
                    deleted: removals.length,
                    left_on_server: opts.prune ? 0 : server.filter(e => !(e.key in dict.entries)).length,
                });
            }
            if (opts.json) { log.json({ ok: true, dryRun: !!opts.dryRun, results }); return; }
            for (const r of results) {
                const t = r.texts as { created?: number; updated?: number; changed?: number };
                const counts = opts.dryRun ? `${t.changed} text${t.changed === 1 ? '' : 's'} would change` : `${t.created} added, ${t.updated} changed`;
                const del = (r.deleted as number) ? `, ${r.deleted} deleted` : '';
                const left = (r.left_on_server as number) ? c.dim(` (${r.left_on_server} only on the server; --prune deletes them)`) : '';
                log.info(`  ${opts.dryRun ? 'would push' : c.green('pushed')} ${r.file}: language ${r.language}, ${counts}${del}${left}`);
            }
        });
}
