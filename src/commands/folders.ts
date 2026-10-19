import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Page, PageFolder } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';
import { hasControlChars } from '../utils/sanitize';

/**
 * `ef folders` — the Folders sidebar of the dashboard's Pages list.
 *
 * Folders are purely for organizing the list: filing a page into one changes
 * its `folder_id` and nothing else. Slug, URL, status, domain and funnel
 * wiring stay exactly as they were, so filing is always safe on live pages.
 *
 * A folder is referenced by numeric id, by name (when the name is unique), or
 * by path ("Kits/Supplement VSL funnel") when two folders share a name.
 */

/** A folder with its position in the tree, as the commands work with it. */
export interface FlatFolder {
    id: number;
    name: string;
    parent_id: number | null;
    color: string | null;
    pages_count: number;
    depth: number;
    /** Names from the root down, joined with "/". */
    path: string;
}

/** Turn the index endpoint's nested tree into a depth-first flat list. */
export function flattenFolders(tree: PageFolder[], parentPath = '', depth = 0): FlatFolder[] {
    const out: FlatFolder[] = [];
    for (const f of tree ?? []) {
        const path = parentPath ? `${parentPath}/${f.name}` : f.name;
        out.push({
            id: f.id,
            name: f.name,
            parent_id: f.parent_id ?? null,
            color: f.color ?? null,
            pages_count: f.pages_count ?? 0,
            depth,
            path,
        });
        if (f.children?.length) out.push(...flattenFolders(f.children, path, depth + 1));
    }
    return out;
}

/** `none`, `null` and `-` mean "no folder" wherever a folder is asked for. */
export function isNoFolder(ref: string): boolean {
    return /^(none|null|-)$/i.test((ref ?? '').trim());
}

/**
 * Resolve a folder reference: id, then exact path, then unique name.
 * Matching is case-insensitive. An ambiguous name lists the candidate paths.
 */
export function resolveFolder(folders: FlatFolder[], ref: string): FlatFolder {
    const raw = (ref ?? '').trim();
    if (!raw) throw new CliError(ExitCode.Validation, 'Empty folder reference. Pass an id, a name or a path like "Kits/My kit".');

    if (/^\d+$/.test(raw)) {
        const byId = folders.find(f => f.id === Number(raw));
        if (byId) return byId;
    }
    const lc = raw.toLowerCase().replace(/\s*\/\s*/g, '/').replace(/^\/+|\/+$/g, '');
    const byPath = folders.filter(f => f.path.toLowerCase() === lc);
    if (byPath.length === 1) return byPath[0];

    const byName = folders.filter(f => f.name.toLowerCase() === raw.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
        throw new CliError(ExitCode.Validation,
            `Folder name "${raw}" is ambiguous. Use the id or the full path: ${byName.map(f => `"${f.path}" (#${f.id})`).join(', ')}.`);
    }
    throw new CliError(ExitCode.NotFound, `No folder "${raw}". Run "ef folders list" to see the folders.`);
}

/** The server accepts only #RRGGBB. */
export function normalizeFolderColor(raw: string): string {
    const v = (raw ?? '').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(v);
    if (!m) throw new CliError(ExitCode.Validation, `Invalid colour "${raw}". Use hex like #4f46e5.`);
    return `#${m[1].toLowerCase()}`;
}

/** Find the sibling with this name under `parentId` (null = top level). */
export function findSibling(folders: FlatFolder[], parentId: number | null, name: string): FlatFolder | undefined {
    const lc = name.trim().toLowerCase();
    return folders.find(f => (f.parent_id ?? null) === parentId && f.name.toLowerCase() === lc);
}

/**
 * Map page references (slugs or ids) to page rows. A slug matches every row
 * that carries it, so a page's variants are filed together with it.
 */
export function matchPages(pages: Page[], refs: string[]): { matched: Page[]; missing: string[] } {
    const matched = new Map<number, Page>();
    const missing: string[] = [];
    for (const ref of refs) {
        const r = ref.trim();
        const hits = /^\d+$/.test(r)
            ? pages.filter(p => p.id === Number(r))
            : pages.filter(p => p.slug === r || p.variant_slug === r);
        if (!hits.length) missing.push(r);
        for (const h of hits) matched.set(h.id, h);
    }
    return { matched: [...matched.values()], missing };
}

/** Shared by `ef pages settings --folder`: folder ref → id (null = none). */
export async function resolveFolderId(api: ApiClient, brandId: number, ref: string): Promise<{ id: number | null; label: string }> {
    if (isNoFolder(ref)) return { id: null, label: 'none' };
    const folder = resolveFolder(flattenFolders(await api.getPageFolderTree(brandId)), ref);
    return { id: folder.id, label: `${folder.path} (#${folder.id})` };
}

async function runtime(): Promise<{ api: ApiClient; brandId: number }> {
    const rt = await loadRuntime();
    return { api: new ApiClient(rt.config.apiUrl, rt.apiKey), brandId: rt.config.brandId };
}

export function registerFoldersCommand(program: Command): void {
    const cmd = program
        .command('folders')
        .alias('folder')
        .description('Page folders: the Folders sidebar of the Pages list. Filing a page changes only its folder, never its slug, URL, status or funnel.')
        .addHelpText('after', `
A folder is referenced by id, by name when unique, or by path ("Kits/My kit").

  $ ef folders list
  $ ef folders create "Kits"
  $ ef folders create "Supplement VSL funnel" --parent Kits --exists-ok
  $ ef folders file "Kits/Supplement VSL funnel" kits/supplement-vsl/vsl kits/supplement-vsl/order
  $ ef folders file none kits/supplement-vsl/vsl        # take it out of any folder
  $ ef pages settings kits/supplement-vsl/vsl --folder "Kits/Supplement VSL funnel"

Folders must be switched on for the brand ("Page folders" in the brand settings).`);

    cmd.command('list')
        .alias('ls')
        .description('Print the folder tree with ids and page counts.')
        .option('--json', 'Print as JSON (flat list with path and depth).')
        .action(async (opts: { json?: boolean }) => {
            const { api, brandId } = await runtime();
            const flat = flattenFolders(await api.getPageFolderTree(brandId));
            if (opts.json) { log.json(flat); return; }
            if (!flat.length) { log.detail('No folders yet. "ef folders create <name>" makes one.'); return; }
            log.raw(renderTable({
                head: ['#', 'folder', 'pages', 'path'],
                rows: flat.map(f => [String(f.id), `${'  '.repeat(f.depth)}${f.name}`, String(f.pages_count), f.path]),
            }) + '\n');
            log.detail(`${flat.length} folders`);
        });

    cmd.command('create <name>')
        .description('Create a folder, at the top level or inside --parent.')
        .option('--parent <folder>', 'Parent folder: id, name or path.')
        .option('--color <hex>', 'Folder colour, #RRGGBB.')
        .option('--exists-ok', 'If a folder with this name already exists under the same parent, print it and exit 0 instead of failing.')
        .option('--json', 'Print the result as JSON.')
        .action(async (name: string, opts: { parent?: string; color?: string; existsOk?: boolean; json?: boolean }) => {
            const trimmed = (name ?? '').trim();
            if (!trimmed) throw new CliError(ExitCode.Validation, 'Folder name is empty.');
            if (hasControlChars(trimmed)) throw new CliError(ExitCode.Validation, 'Folder name has control or bidi characters; use plain text.');
            const color = opts.color ? normalizeFolderColor(opts.color) : undefined;
            const { api, brandId } = await runtime();
            const flat = flattenFolders(await api.getPageFolderTree(brandId));
            const parent = opts.parent ? resolveFolder(flat, opts.parent) : null;
            const existing = findSibling(flat, parent?.id ?? null, trimmed);
            if (existing) {
                if (!opts.existsOk) {
                    throw new CliError(ExitCode.Validation, `Folder "${existing.path}" (#${existing.id}) already exists. Pass --exists-ok to reuse it.`);
                }
                if (opts.json) { log.json({ ok: true, created: false, folder: existing }); return; }
                log.success(`Folder ${c.bold(existing.path)} (#${existing.id}) already exists.`);
                return;
            }
            const folder = await api.createPageFolder(brandId, {
                name: trimmed,
                ...(parent ? { parent_id: parent.id } : {}),
                ...(color ? { color } : {}),
            });
            const path = parent ? `${parent.path}/${folder.name}` : folder.name;
            if (opts.json) { log.json({ ok: true, created: true, folder: { ...folder, path } }); return; }
            log.success(`Created folder ${c.bold(path)} (#${folder.id}).`);
        });

    cmd.command('rename <folder> <newName>')
        .description('Rename a folder. Its pages and subfolders stay in it.')
        .option('--json', 'Print the result as JSON.')
        .action(async (ref: string, newName: string, opts: { json?: boolean }) => {
            const trimmed = (newName ?? '').trim();
            if (!trimmed) throw new CliError(ExitCode.Validation, 'New folder name is empty.');
            if (hasControlChars(trimmed)) throw new CliError(ExitCode.Validation, 'Folder name has control or bidi characters; use plain text.');
            const { api, brandId } = await runtime();
            const flat = flattenFolders(await api.getPageFolderTree(brandId));
            const folder = resolveFolder(flat, ref);
            const clash = findSibling(flat, folder.parent_id, trimmed);
            if (clash && clash.id !== folder.id) {
                throw new CliError(ExitCode.Validation, `A sibling folder "${clash.path}" (#${clash.id}) already has that name.`);
            }
            const updated = await api.updatePageFolder(brandId, folder.id, { name: trimmed });
            if (opts.json) { log.json({ ok: true, folder: updated }); return; }
            log.success(`Renamed ${c.bold(folder.path)} → ${c.bold(updated.name ?? trimmed)} (#${folder.id}).`);
        });

    cmd.command('delete <folder>')
        .description('Delete a folder. Its pages go back to "no folder" (they are not deleted); its subfolders move up one level.')
        .option('--force', 'Skip the confirmation prompt.')
        .option('--json', 'Print the result as JSON.')
        .action(async (ref: string, opts: { force?: boolean; json?: boolean }) => {
            const { api, brandId } = await runtime();
            const folder = resolveFolder(flattenFolders(await api.getPageFolderTree(brandId)), ref);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete folder "${folder.path}" (#${folder.id})? Its ${folder.pages_count} page(s) stay, unfiled.`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deletePageFolder(brandId, folder.id);
            if (opts.json) { log.json({ ok: true, deleted: { id: folder.id, path: folder.path } }); return; }
            log.success(`Deleted folder ${c.bold(folder.path)} (#${folder.id}).`);
        });

    cmd.command('file <folder> <pages...>')
        .alias('move')
        .description('File pages (slugs or ids) into a folder in one call. Use "none" as the folder to unfile them. Only the folder changes.')
        .option('--all-types', 'Also match visual-builder and legacy pages, not only code-editor pages.')
        .option('--json', 'Print the result as JSON.')
        .action(async (ref: string, pageRefs: string[], opts: { allTypes?: boolean; json?: boolean }) => {
            const { api, brandId } = await runtime();
            const target = await resolveFolderId(api, brandId, ref);
            const pages = await api.listPages(brandId, 100000, { allTypes: opts.allTypes });
            const { matched, missing } = matchPages(pages, pageRefs);
            if (missing.length) {
                throw new CliError(ExitCode.NotFound, `No page for: ${missing.join(', ')}. Nothing was moved.`);
            }
            const moved = await api.movePagesToFolder(brandId, matched.map(p => p.id), target.id);
            if (opts.json) {
                log.json({ ok: true, folder: target, moved: matched.map(p => ({ id: p.id, slug: p.slug })), moved_count: moved });
                return;
            }
            log.success(`Filed ${moved} page(s) into ${c.bold(target.label)}.`);
        });
}
