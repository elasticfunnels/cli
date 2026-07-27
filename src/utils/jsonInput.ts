import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { CliError, ExitCode } from './exit';
import { log } from './log';

/**
 * AWS-CLI-style JSON input for commands whose payload is too rich for flags.
 * A command opts in with `addInputOptions`, then in its action:
 *   1. `if (maybeGenerateSkeleton(opts, SKELETON)) return;`
 *   2. `const base = await loadInputBase(opts);`
 *   3. `const payload = mergeDefined(base, { name: opts.name, ... });`
 * so JSON is the base and any flags the user also passed win over it.
 */
export interface JsonInputOpts { inputJson?: string; inputFile?: string; generateSkeleton?: boolean; }

export function addInputOptions(cmd: Command): Command {
    return cmd
        .option('--input-json <json>', 'Full request payload as an inline JSON string.')
        .option('--input-file <path>', 'Read the JSON request payload from a file ("-" for stdin).')
        .option('--generate-skeleton', 'Print an example JSON payload for this command and exit (fill it in, then pass via --input-file).');
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => (data += d));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

/** Parse the JSON payload from --input-json or --input-file, or {} if neither. */
export async function loadInputBase(opts: JsonInputOpts): Promise<Record<string, unknown>> {
    if (opts.inputJson != null && opts.inputFile != null) {
        throw new CliError(ExitCode.Validation, '--input-json and --input-file are mutually exclusive.');
    }
    let raw: string | null = null;
    if (opts.inputJson != null) {
        raw = opts.inputJson;
    } else if (opts.inputFile != null) {
        try {
            raw = opts.inputFile === '-' ? await readStdin() : await fs.promises.readFile(path.resolve(opts.inputFile), 'utf8');
        } catch {
            throw new CliError(ExitCode.NotFound, `Could not read --input-file "${opts.inputFile}".`);
        }
    }
    if (raw == null || raw.trim() === '') return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new CliError(ExitCode.Validation, `Invalid JSON payload: ${(err as Error).message}`);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CliError(ExitCode.Validation, 'JSON payload must be an object.');
    }
    return parsed as Record<string, unknown>;
}

/** If --generate-skeleton was passed, print the skeleton to stdout and return true. */
export function maybeGenerateSkeleton(opts: JsonInputOpts, skeleton: unknown): boolean {
    if (!opts.generateSkeleton) return false;
    log.json(skeleton);
    return true;
}

/** Overlay flag-derived fields (dropping `undefined`) on top of the JSON base. */
export function mergeDefined(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) out[k] = v;
    return out;
}
