import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatBytes, formatRelative, renderTable } from '../utils/format';

type Kind = 'pages' | 'components' | 'assets' | 'scripts' | 'folders' | 'templates';

const VALID: Kind[] = ['pages', 'components', 'assets', 'scripts', 'folders', 'templates'];

export function registerListCommand(program: Command): void {
    program
        .command('list <kind>')
        .alias('ls')
        .description(`List entities. <kind> = ${VALID.join(' | ')}.`)
        .option('--limit <n>', 'Limit rows shown (default: all).', (v) => parseInt(v, 10))
        .option('--json', 'Print rows as JSON.')
        .action(async (kindRaw: string, opts: { limit?: number; json?: boolean }) => {
            const kind = kindRaw.toLowerCase() as Kind;
            if (!VALID.includes(kind)) {
                throw new CliError(ExitCode.Validation, `Unknown kind "${kindRaw}". Use one of: ${VALID.join(', ')}.`);
            }
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);

            switch (kind) {
                case 'pages': return printPagesList(api, rt.config.brandId, opts);
                case 'components': return listComponents(api, rt.config.brandId, opts);
                case 'assets': return listAssets(api, rt.config.brandId, opts);
                case 'scripts': return listScripts(api, rt.config.brandId, opts);
                case 'folders': return listFolders(api, rt.config.brandId, opts);
                case 'templates': return listTemplates(api, rt.config.brandId, opts);
            }
        });
}

/** Shared with `ef pages list` — same output as `ef list pages`. */
export async function printPagesList(api: ApiClient, brandId: number, opts: { limit?: number; json?: boolean }): Promise<void> {
    const pages = await api.listPages(brandId, opts.limit ?? 10000);
    if (opts.json) { log.json(pages); return; }
    log.raw(renderTable({
        head: ['#', 'slug', 'title', 'status', 'updated'],
        rows: pages.map(p => [
            String(p.id),
            p.slug ?? '',
            p.title ?? '',
            p.status ?? '',
            formatRelative(p.updated_at),
        ]),
    }) + '\n');
    log.detail(`${pages.length} pages`);
}

async function listComponents(api: ApiClient, brandId: number, opts: { limit?: number; json?: boolean }): Promise<void> {
    const components = await api.listComponents(brandId);
    const rows = opts.limit ? components.slice(0, opts.limit) : components;
    if (opts.json) { log.json(rows); return; }
    log.raw(renderTable({
        head: ['#', 'code', 'name', 'updated'],
        rows: rows.map(c => [String(c.id), c.code ?? '', c.name ?? '', formatRelative(c.updated_at)]),
    }) + '\n');
    log.detail(`${rows.length} components`);
}

async function listAssets(api: ApiClient, brandId: number, opts: { limit?: number; json?: boolean }): Promise<void> {
    const assets = await api.listAssets(brandId);
    const rows = opts.limit ? assets.slice(0, opts.limit) : assets;
    if (opts.json) { log.json(rows); return; }
    log.raw(renderTable({
        head: ['#', 'path', 'size', 'updated'],
        rows: rows.map(a => [String(a.id), a.file_path, formatBytes(a.size ?? null), formatRelative(a.updated_at)]),
    }) + '\n');
    log.detail(`${rows.length} assets`);
}

async function listScripts(api: ApiClient, brandId: number, opts: { limit?: number; json?: boolean }): Promise<void> {
    const scripts = await api.listBackendScripts(brandId);
    const rows = opts.limit ? scripts.slice(0, opts.limit) : scripts;
    if (opts.json) { log.json(rows); return; }
    log.raw(renderTable({
        head: ['#', 'code', 'name', 'status', 'updated'],
        rows: rows.map(s => [String(s.id), s.code, s.name, s.status ?? '', formatRelative(s.updated_at)]),
    }) + '\n');
    log.detail(`${rows.length} scripts`);
}

async function listFolders(api: ApiClient, brandId: number, opts: { json?: boolean }): Promise<void> {
    const folders = await api.listPageFolders(brandId);
    if (opts.json) { log.json(folders); return; }
    log.raw(renderTable({
        head: ['#', 'name', 'parent'],
        rows: folders.map(f => [String(f.id), f.name, f.parent_id != null ? String(f.parent_id) : '']),
    }) + '\n');
    log.detail(`${folders.length} folders`);
}

async function listTemplates(api: ApiClient, brandId: number, opts: { json?: boolean }): Promise<void> {
    const templates = await api.listTemplates(brandId);
    if (opts.json) { log.json(templates); return; }
    log.raw(renderTable({
        head: ['#', 'slug', 'name', 'mode', 'updated'],
        rows: templates.map(t => [String(t.id), t.slug, t.name, t.edit_mode ?? '', formatRelative(t.updated_at)]),
    }) + '\n');
    log.detail(`${templates.length} templates`);
}
