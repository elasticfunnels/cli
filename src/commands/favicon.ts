import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';

/**
 * `ef favicon` — the brand favicon from Settings -> General.
 *
 * The page runtime links it on every page that has no favicon of its own and
 * whose HTML links no icon. A page that links its own icon (a layout with
 * <link rel="icon">) never gets this one, so it does not override it.
 */

/** What the server accepts (UpdateBrand: png, jpeg, jpg, webp; no svg, no ico). */
export const FAVICON_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
/** Server limit is PHP's upload size; keep favicons small anyway. */
export const FAVICON_MAX_BYTES = 1024 * 1024;

export function validateFaviconFile(name: string, size: number): void {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!(FAVICON_EXTENSIONS as readonly string[]).includes(ext)) {
        throw new CliError(ExitCode.Validation,
            `A favicon must be ${FAVICON_EXTENSIONS.join(', ')}; got "${name}". SVG and ICO are refused by the server (SVG can carry script). Export a square PNG, e.g. 64x64 or 192x192.`);
    }
    if (size === 0) throw new CliError(ExitCode.Validation, `"${name}" is empty.`);
    if (size > FAVICON_MAX_BYTES) {
        throw new CliError(ExitCode.Validation, `"${name}" is ${(size / 1024).toFixed(0)} KB; keep a favicon under 1 MB (a 192x192 PNG is a few KB).`);
    }
}

async function urlAnswers(url: string): Promise<number | null> {
    try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow' });
        return res.status;
    } catch {
        return null;
    }
}

const OLD_SERVER = 'This server does not report the brand favicon yet (it needs the app release with `favicon_link`).';

export function registerFaviconCommand(program: Command): void {
    const cmd = program
        .command('favicon')
        .description('Brand favicon (Settings -> General): show, set <file>, clear.')
        .addHelpText('after', `
Examples:
  $ ef favicon                    # show the current brand favicon URL
  $ ef favicon set icon-192.png   # upload a new one (png, jpg, webp)
  $ ef favicon clear              # remove it

Pages use it only when they have no favicon of their own and their HTML
links no <link rel="icon">. A page that links its own icon keeps it.`);

    cmd.command('show', { isDefault: true })
        .description('Print the brand favicon URL and whether it loads.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const { favicon } = await api.getBrandFavicon(rt.config.brandId);
            if (favicon === undefined) throw new CliError(ExitCode.Error, OLD_SERVER);
            const status = favicon ? await urlAnswers(favicon) : null;
            if (opts.json) { log.json({ favicon, status }); return; }
            if (!favicon) { log.info('No brand favicon. Set one with "ef favicon set <file>".'); return; }
            process.stdout.write(`${favicon}\n`);
            if (status !== 200) {
                log.warn(`That URL answers ${status ?? 'nothing'}; browsers show no icon from it. Upload it again with "ef favicon set <file>", or "ef favicon clear".`);
            }
        });

    cmd.command('set <file>')
        .description('Upload the brand favicon (png, jpg or webp; square, e.g. 192x192).')
        .option('--json', 'Print the result as JSON.')
        .action(async (file: string, opts: { json?: boolean }) => {
            const abs = path.resolve(file);
            const name = path.basename(abs);
            let bytes: Buffer;
            try {
                bytes = await fs.promises.readFile(abs);
            } catch {
                throw new CliError(ExitCode.Validation, `File not found or unreadable: ${file}`);
            }
            validateFaviconFile(name, bytes.length);

            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const before = await api.getBrandFavicon(rt.config.brandId);
            await api.setBrandFavicon(rt.config.brandId, before.name, { name, bytes });
            const after = await api.getBrandFavicon(rt.config.brandId);
            const status = after.favicon ? await urlAnswers(after.favicon) : null;

            if (opts.json) { log.json({ ok: true, favicon: after.favicon ?? null, status }); return; }
            log.success('Brand favicon uploaded.');
            if (after.favicon) {
                log.detail(`  ${after.favicon}${status === 200 ? '' : `  (answers ${status ?? 'nothing'})`}`);
            } else if (after.favicon === undefined) {
                log.detail(`  ${OLD_SERVER}`);
            }
            log.detail('  Browsers cache favicons; a hard refresh or a new tab shows the new one.');
        });

    cmd.command('clear')
        .description('Remove the brand favicon. Pages with their own favicon are not affected.')
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const before = await api.getBrandFavicon(rt.config.brandId);
            if (before.favicon === undefined) throw new CliError(ExitCode.Error, OLD_SERVER);
            if (before.favicon === null) {
                if (opts.json) { log.json({ ok: true, favicon: null, changed: false }); return; }
                log.info('No brand favicon to remove.');
                return;
            }
            await api.clearBrandFavicon(rt.config.brandId, before.name);
            const after = await api.getBrandFavicon(rt.config.brandId);
            if (after.favicon) {
                throw new CliError(ExitCode.Error, `The server kept the favicon (${after.favicon}); it may predate "ef favicon clear".`);
            }
            if (opts.json) { log.json({ ok: true, favicon: null, changed: true }); return; }
            log.success('Brand favicon removed.');
        });
}
