import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { Page, Component, BackendScript } from '../api/types';
import { resolvePageBySlug } from './shared';

type Kind = 'page' | 'component' | 'script' | 'asset';

export function registerGetCommand(program: Command): void {
    program
        .command('get <kind> <idOrSlug>')
        .description('Fetch a single entity. <kind> = page | component | script | asset.')
        .option('--published', 'For pages/components: get the published revision instead of the editor draft.')
        .option('--html', 'Print only the HTML body (default for non-JSON).')
        .option('--json', 'Print the full payload as JSON.')
        .action(async (kindRaw: string, idOrSlug: string, opts: { published?: boolean; html?: boolean; json?: boolean }) => {
            const kind = kindRaw.toLowerCase() as Kind;
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);

            switch (kind) {
                case 'page': return await runPage(api, rt.config.brandId, idOrSlug, opts);
                case 'component': return await runComponent(api, rt.config.brandId, idOrSlug, opts);
                case 'script': return await runScript(api, rt.config.brandId, idOrSlug, opts);
                case 'asset': return await runAsset(api, rt.config.brandId, idOrSlug, opts);
                default:
                    throw new CliError(ExitCode.Validation, `Unknown kind "${kindRaw}". Use page | component | script | asset.`);
            }
        });
}

async function runPage(api: ApiClient, brandId: number, idOrSlug: string, opts: { published?: boolean; html?: boolean; json?: boolean }): Promise<void> {
    const id = parseInt(idOrSlug, 10);
    let page: Page;
    if (Number.isFinite(id) && /^\d+$/.test(idOrSlug)) {
        page = await api.getPageContent(brandId, id, { published: opts.published });
    } else {
        const ref = await resolvePageBySlug(api, brandId, idOrSlug);
        page = await api.getPageContent(brandId, ref.id, { published: opts.published });
    }
    if (opts.json) { log.json(page); return; }
    process.stdout.write((page.html ?? '') + (page.html?.endsWith('\n') ? '' : '\n'));
}

async function runComponent(api: ApiClient, brandId: number, idOrSlug: string, opts: { published?: boolean; html?: boolean; json?: boolean }): Promise<void> {
    let id = parseInt(idOrSlug, 10);
    if (!Number.isFinite(id) || !/^\d+$/.test(idOrSlug)) {
        const all = await api.listComponents(brandId);
        const found = all.find(c => c.code === idOrSlug || c.name === idOrSlug);
        if (!found) throw new CliError(ExitCode.NotFound, `Component "${idOrSlug}" not found.`);
        id = found.id;
    }
    const comp: Component = await api.getComponentContent(brandId, id, { published: opts.published });
    if (opts.json) { log.json(comp); return; }
    process.stdout.write((comp.html ?? '') + (comp.html?.endsWith('\n') ? '' : '\n'));
}

async function runScript(api: ApiClient, brandId: number, idOrSlug: string, opts: { html?: boolean; json?: boolean }): Promise<void> {
    const script: BackendScript = await api.getBackendScript(brandId, idOrSlug);
    if (opts.json) { log.json(script); return; }
    process.stdout.write((script.content ?? '') + (script.content?.endsWith('\n') ? '' : '\n'));
}

async function runAsset(api: ApiClient, brandId: number, idOrSlug: string, opts: { json?: boolean }): Promise<void> {
    let fileId = parseInt(idOrSlug, 10);
    if (!Number.isFinite(fileId) || !/^\d+$/.test(idOrSlug)) {
        const ref = await api.getAssetByPath(brandId, idOrSlug);
        if (!ref) throw new CliError(ExitCode.NotFound, `Asset "${idOrSlug}" not found.`);
        fileId = ref.id;
    }
    const payload = await api.getAssetContent(brandId, fileId);
    if (opts.json) { log.json(payload); return; }
    if (payload.content_base64) {
        process.stdout.write(Buffer.from(payload.content_base64, 'base64'));
    } else {
        process.stdout.write((payload.html ?? '') + '\n');
    }
}
