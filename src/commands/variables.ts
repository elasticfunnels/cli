import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { writeFileAtomic } from '../utils/fs';

export function registerVariablesCommand(program: Command): void {
    const cmd = program
        .command('variables')
        .description('Brand variables: get, set <key> <value>, pull, push.');

    cmd.command('get')
        .description('Print the brand variables as JSON.')
        .action(async () => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const vars = await api.getBrandVariables(rt.config.brandId);
            log.json(vars);
        });

    cmd.command('pull')
        .description(`Pull the variables JSON to <syncRoot>/<brandId>/variables.json on disk.`)
        .action(async () => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const vars = await api.getBrandVariables(rt.config.brandId);
            const out = path.join(rt.brandRoot, 'variables.json');
            await writeFileAtomic(out, JSON.stringify(vars, null, 2) + '\n');
            log.success(`Wrote ${out}`);
        });

    cmd.command('push')
        .description('Push <syncRoot>/<brandId>/variables.json (or --file) to the server.')
        .option('--file <path>', 'Read variables JSON from this path instead of the default.')
        .action(async (opts: { file?: string }) => {
            const rt = await loadRuntime();
            const file = opts.file ? path.resolve(opts.file) : path.join(rt.brandRoot, 'variables.json');
            let raw: string;
            try {
                raw = await fs.promises.readFile(file, 'utf8');
            } catch {
                throw new CliError(ExitCode.NotFound, `Variables file not found: ${file}. Run "ef variables pull" or pass --file <path>.`);
            }
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch (err) {
                throw new CliError(ExitCode.Validation, `Variables file is not valid JSON: ${(err as Error).message}`);
            }
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            await api.setBrandVariables(rt.config.brandId, parsed);
            log.success(`Pushed ${Object.keys(parsed).length} variables.`);
        });

    cmd.command('set <key> <value>')
        .description('Set ONE brand variable, then push. Dotted keys nest (brand.name → { brand: { name } }). '
            + '<value> is parsed as JSON when valid (180 → number, true → boolean, {…}/[…] → object/array), otherwise kept as a string; '
            + 'use @path to read the value from a file, or --string to force a literal string.')
        .option('--string', 'Treat <value> as a literal string (no JSON parsing, no @file expansion).')
        .option('--json', 'Print the full updated variables object as JSON.')
        .action(async (key: string, value: string, opts: { string?: boolean; json?: boolean }) => {
            const segments = key.split('.');
            if (!key || segments.some((s) => s.trim() === '')) {
                throw new CliError(ExitCode.Validation, `Invalid key "${key}". Use dotted segments like brand.name (no empty segments).`);
            }
            const resolved = await resolveSetValue(value, opts);
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const current = await api.getBrandVariables(rt.config.brandId);
            // Deep-clone the current object so we never mutate shared references,
            // and start clean if the server has no (or a non-object) variables blob.
            const next = current && typeof current === 'object' && !Array.isArray(current)
                ? (JSON.parse(JSON.stringify(current)) as Record<string, unknown>)
                : {};
            setDeep(next, segments, resolved);
            await api.setBrandVariables(rt.config.brandId, next);
            if (opts.json) { log.json(next); return; }
            log.success(`Set ${key} = ${previewValue(resolved)}`);
        });
}

/** Turn the raw CLI <value> into the stored value: literal string (--string),
 *  file contents (@path), or JSON when it parses, else a plain string. */
async function resolveSetValue(raw: string, opts: { string?: boolean }): Promise<unknown> {
    if (opts.string) return raw;
    if (raw.startsWith('@')) {
        const p = path.resolve(raw.slice(1));
        let content: string;
        try {
            content = await fs.promises.readFile(p, 'utf8');
        } catch {
            throw new CliError(ExitCode.Validation, `Value "${raw}" references a file that could not be read (${p}). Use --string to set a literal value that begins with "@".`);
        }
        return content.replace(/\n+$/, '');
    }
    const trimmed = raw.trim();
    if (trimmed === '') return raw;
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return raw;
    }
}

/** Assign `value` at a dotted path, creating intermediate objects. Refuses to
 *  descend through a non-object (would silently drop the existing value). */
function setDeep(obj: Record<string, unknown>, segments: string[], value: unknown): void {
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < segments.length - 1; i++) {
        const k = segments[i];
        const existing = cur[k];
        if (existing === undefined || existing === null) {
            cur[k] = {};
        } else if (typeof existing !== 'object' || Array.isArray(existing)) {
            const where = segments.slice(0, i + 1).join('.');
            throw new CliError(ExitCode.Validation, `Cannot set "${segments.join('.')}": "${where}" is already a ${Array.isArray(existing) ? 'array' : typeof existing}, not an object. Overwrite it explicitly if that's intended.`);
        }
        cur = cur[k] as Record<string, unknown>;
    }
    cur[segments[segments.length - 1]] = value;
}

/** One-line preview of a value for the success message. */
function previewValue(v: unknown): string {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
