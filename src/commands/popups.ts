import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';

/**
 * `ef popups` — exit popups (the `exit_popup` page-event node shows one by id).
 *
 * A popup stores two copies of its content: `html` + `css`, which the website
 * runtime renders (views/exitpopup.twig), and `config`, the GrapesJS project
 * the visual editor loads. The server keeps whatever it is sent. `push` writes
 * all three from one .html file: the markup and its <style> blocks become
 * html/css, and `config` gets the same markup as a components string, which
 * GrapesJS parses (styles included) the first time the popup is opened.
 */

export const POPUP_TEMPLATES = ['default-with-image', 'default-with-video', 'subscribe-modal-1'] as const;

/** Split a popup source file into markup and CSS (every <style> block, in order). */
export function splitPopupSource(source: string): { html: string; css: string } {
    const css: string[] = [];
    const html = source.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, body: string) => { css.push(body.trim()); return ''; }).trim();
    return { html, css: css.join('\n') };
}

/**
 * The builder save payload for a popup source file. Throws when the markup has
 * no `data-modal` element: show_exit_popup.js shows `[data-modal]` and wires
 * `[data-modal-close="true"]` to close it, so without one the popup never opens.
 */
export function popupBuilderPayload(source: string): { config: string; html: string; css: string; interactions: unknown[] } {
    const { html, css } = splitPopupSource(source);
    if (!html) throw new CliError(ExitCode.Validation, 'The popup file has no markup.');
    if (!/\sdata-modal(\s*=\s*["']?true["']?)?[\s>]/i.test(html)) {
        throw new CliError(ExitCode.Validation, 'The popup markup needs an element with data-modal="true" (the runtime shows it) and a button with data-modal-close="true" (closes it).');
    }
    const components = css ? `${html}\n<style>${css}</style>` : html;
    const config = {
        assets: [], styles: [], fonts: [],
        pages: [{ frames: [{ component: { type: 'wrapper', components } }] }],
    };
    return { config: JSON.stringify(config), html, css, interactions: [] };
}

async function ctx(): Promise<{ api: ApiClient; brandId: number }> {
    const rt = await loadRuntime();
    return { api: new ApiClient(rt.config.apiUrl, rt.apiKey), brandId: rt.config.brandId };
}

/** A popup by numeric id or exact name (case-insensitive). */
async function resolvePopup(api: ApiClient, brandId: number, ref: string): Promise<{ id: number; name: string }> {
    const all = await api.listPopups(brandId);
    if (/^\d+$/.test(ref)) {
        return all.find((p) => p.id === Number(ref)) ?? { id: Number(ref), name: ref };
    }
    const hits = all.filter((p) => (p.name ?? '').toLowerCase() === ref.toLowerCase());
    if (hits.length > 1) throw new CliError(ExitCode.Validation, `${hits.length} popups are named "${ref}" (${hits.map((h) => `#${h.id}`).join(', ')}); pass the id.`);
    if (!hits.length) throw new CliError(ExitCode.NotFound, `No popup named "${ref}" in this brand. Run "ef popups list".`);
    return hits[0];
}

function readSource(file: string): string {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new CliError(ExitCode.NotFound, `File not found: ${file}`);
    return fs.readFileSync(abs, 'utf8');
}

export function registerPopupsCommand(program: Command): void {
    const cmd = program
        .command('popups')
        .alias('popup')
        .description('Exit popups — list, inspect, create and push the popups that the exit_popup page-event node shows.')
        .addHelpText('after', `
A popup file is plain HTML plus <style> blocks. The runtime shows the element
with data-modal="true" and closes it on any data-modal-close="true" click:

  <div class="fs-overlay" data-modal="true">
    <div class="fs-box">
      <button data-modal-close="true">×</button>
      <h2>Free shipping on this order</h2>
    </div>
  </div>
  <style>.fs-overlay{position:fixed;inset:0;display:none}</style>

Show it on a page with the page-events graph (ef pages events pull <slug>):
an "exit_intent" node wired to an "exit_popup" node whose data.value is the
popup id.`);

    cmd.command('list').alias('ls')
        .description('List the brand\'s popups (id, name).')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const rows = await api.listPopups(brandId);
            if (opts.json) { log.json({ ok: true, popups: rows }); return; }
            if (!rows.length) { log.info('No popups yet. Create one with "ef popups create <name> --file popup.html".'); return; }
            log.raw(renderTable({ head: ['id', 'name'], rows: rows.map((r) => [String(r.id), r.name ?? '']) }) + '\n');
        });

    cmd.command('get <nameOrId>')
        .description('Show one popup. --json includes the editor project (config).')
        .option('--json', 'Print as JSON.')
        .action(async (ref: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const { id } = await resolvePopup(api, brandId, ref);
            const popup = await api.getPopup(brandId, id);
            if (opts.json) { log.json({ ok: true, popup }); return; }
            log.info(`${c.bold(popup.name)} ${c.dim(`#${popup.id}`)}`);
            log.detail('  The rendered html/css are not readable through the API; --json prints the editor project.');
        });

    cmd.command('create <name>')
        .description('Create a popup. --file sets its content from an HTML file; otherwise it starts from a built-in template.')
        .option('--file <path>', 'Popup source (HTML + <style>), pushed right after creating.')
        .option('--template <name>', `Built-in starting template: ${POPUP_TEMPLATES.join(', ')}.`, 'default-with-image')
        .option('--json', 'Print result as JSON.')
        .action(async (name: string, opts: { file?: string; template: string; json?: boolean }) => {
            if (!(POPUP_TEMPLATES as readonly string[]).includes(opts.template)) {
                throw new CliError(ExitCode.Validation, `Unknown --template "${opts.template}". Use one of: ${POPUP_TEMPLATES.join(', ')}.`);
            }
            // Validate the file before anything is created on the server.
            const payload = opts.file ? popupBuilderPayload(readSource(opts.file)) : null;
            const { api, brandId } = await ctx();
            const created = await api.createPopup(brandId, name, opts.template);
            if (payload) await api.savePopupContent(brandId, created.id, payload);
            if (opts.json) { log.json({ ok: true, popup: created, pushed: Boolean(payload) }); return; }
            log.success(`Created popup "${created.name}" (#${created.id})${payload ? ` from ${opts.file}` : ` from template ${opts.template}`}.`);
            log.detail(`  Show it with an exit_popup page-event node, data.value ${created.id}.`);
        });

    cmd.command('push <nameOrId> <file>')
        .description('Replace a popup\'s content with an HTML file (markup + <style>). Overwrites edits made in the visual editor.')
        .option('--json', 'Print result as JSON.')
        .action(async (ref: string, file: string, opts: { json?: boolean }) => {
            const payload = popupBuilderPayload(readSource(file));
            const { api, brandId } = await ctx();
            const popup = await resolvePopup(api, brandId, ref);
            await api.savePopupContent(brandId, popup.id, payload);
            if (opts.json) { log.json({ ok: true, popup: { id: popup.id, name: popup.name }, html_bytes: payload.html.length, css_bytes: payload.css.length }); return; }
            log.success(`Pushed ${file} → popup "${popup.name}" (#${popup.id}).`);
        });
}
