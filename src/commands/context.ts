import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { KitContextApi } from '../api/kitContextApi';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatMissing, pullKitContext, CONTEXT_DIR } from '../lib/kitContext';
import { docxBytesToMarkdown } from '../lib/docx2md';

/** `"12"` -> 12, `"true"` -> true, `'["a"]'` -> array; anything else stays the string it is. */
export function parseFactValue(raw: string): unknown {
    const t = raw.trim();
    if (/^(?:-?\d+(?:\.\d+)?|true|false|null)$/.test(t) || /^[[{"]/.test(t)) {
        try {
            return JSON.parse(t);
        } catch { /* a plain string that happens to start with a bracket */ }
    }
    return raw;
}

/** Set `a.b.c` in a copy of `obj`. */
export function setPath(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
    const out = JSON.parse(JSON.stringify(obj ?? {})) as Record<string, unknown>;
    const parts = key.split('.').filter(Boolean);
    if (!parts.length) throw new CliError(ExitCode.Validation, 'A fact key is required.');
    let cur: Record<string, unknown> = out;
    for (const p of parts.slice(0, -1)) {
        if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {};
        cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
    return out;
}

export function registerContextCommand(program: Command): void {
    const cmd = program
        .command('context')
        .description('The brand\'s kit AI context: brief, facts, assets, image slots and what is still missing.');

    cmd.command('pull')
        .description(`Write the kit context to ${CONTEXT_DIR}/ (kit.json, brief.md, facts.json, assets.json + assets/, slots.json, missing.json). Read-only; only changed files are downloaded.`)
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey, rt.auth);
            const r = await pullKitContext(rt.projectRoot, api, rt.config.brandId);
            if (opts.json) {
                log.json({ ok: r.failed.length === 0, dir: path.relative(process.cwd(), r.dir) || '.', hasContext: r.hasContext, written: r.written, unchanged: r.unchanged.length, downloaded: r.downloaded, kept: r.kept.length, removed: r.removed, failed: r.failed, blockers: r.blockers.length, missing: r.missing.length });
            } else {
                if (!r.hasContext) log.warn('This brand has no kit context yet (no kit applied, no brief). Files written are empty.');
                log.success(`Kit context in ${path.relative(process.cwd(), r.dir) || r.dir}: ${r.written.length} file(s) updated, ${r.unchanged.length} unchanged, ${r.downloaded.length} asset(s) downloaded, ${r.kept.length} kept, ${r.removed.length} removed.`);
                for (const f of r.failed) log.warn(`${f.name}: ${f.error}`);
                if (r.missing.length) log.info(`${r.missing.length} item(s) missing${r.blockers.length ? `, ${r.blockers.length} blocking` : ''}: run ${c.bold('ef context missing')}.`);
            }
            if (r.failed.length) process.exitCode = ExitCode.Error;
        });

    cmd.command('missing')
        .description('List what the kit still needs: product images, images for slots, facts, Drive problems. Blocking rows first.')
        .option('--json', 'Print the list as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const rows = await new KitContextApi(new ApiClient(rt.config.apiUrl, rt.apiKey, rt.auth), rt.config.brandId).missing();
            if (opts.json) {
                log.json({ ok: true, blockers: rows.filter((r) => r.blocking).length, data: rows });
                return;
            }
            if (!rows.length) {
                log.success('Nothing missing.');
                return;
            }
            for (const line of formatMissing(rows)) console.log(line);
        });

    const facts = cmd.command('facts').description('Offer facts (product names, prices, guarantee, ingredients, audience).');
    facts.command('set <key> <value>')
        .description('Set one fact. Dotted keys nest (guarantee.days). Numbers, true/false and JSON arrays/objects are parsed; anything else is a string.')
        .option('--json', 'Print the saved facts as JSON.')
        .action(async (key: string, value: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const ctxApi = new KitContextApi(new ApiClient(rt.config.apiUrl, rt.apiKey, rt.auth), rt.config.brandId);
            const cur = await ctxApi.get();
            const next = setPath((cur.context?.facts ?? {}) as Record<string, unknown>, key, parseFactValue(value));
            const saved = await ctxApi.put({ facts: next });
            if (opts.json) {
                log.json({ ok: true, facts: saved.context?.facts ?? next });
                return;
            }
            log.success(`Saved fact ${key}.`);
        });

    const brief = cmd.command('brief').description('The owner\'s brief for the kit.');
    brief.command('set')
        .description('Replace the brief with the text of a file (.md, .txt, or .docx converted to Markdown), or with --text.')
        .option('--file <path>', 'Brief file: .md, .txt or .docx.')
        .option('--text <text>', 'Brief text.')
        .option('--json', 'Print the result as JSON.')
        .action(async (opts: { file?: string; text?: string; json?: boolean }) => {
            if (!opts.file === !opts.text) throw new CliError(ExitCode.Validation, 'Pass exactly one of --file <path> or --text <text>.');
            let md = opts.text ?? '';
            if (opts.file) {
                const abs = path.resolve(process.cwd(), opts.file);
                let bytes: Buffer;
                try {
                    bytes = await fs.promises.readFile(abs);
                } catch {
                    throw new CliError(ExitCode.NotFound, `File not found: ${opts.file}`);
                }
                const ext = path.extname(abs).toLowerCase();
                if (ext === '.docx') {
                    try {
                        md = docxBytesToMarkdown(bytes);
                    } catch (e) {
                        throw new CliError(ExitCode.Validation, `Cannot read ${opts.file} as .docx: ${(e as Error).message}`);
                    }
                } else if (ext === '.md' || ext === '.txt' || ext === '') {
                    md = bytes.toString('utf8');
                } else {
                    throw new CliError(ExitCode.Validation, `Brief files are .md, .txt or .docx. For a PDF, upload it with: ef assets add ${opts.file} --role reference`);
                }
            }
            const rt = await loadRuntime();
            await new KitContextApi(new ApiClient(rt.config.apiUrl, rt.apiKey, rt.auth), rt.config.brandId).put({ brief_md: md });
            if (opts.json) {
                log.json({ ok: true, chars: md.length });
                return;
            }
            log.success(`Saved the brief (${md.length} characters).`);
        });
}
