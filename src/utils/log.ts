/**
 * Tiny ANSI-aware logger. Writes human-readable status to stderr (so it
 * never pollutes piped JSON on stdout) and structured payloads to stdout
 * when `--json` is requested.
 *
 * Why our own instead of `chalk` / `picocolors`: zero deps means the CLI
 * stays tiny and `npm i -g` is sub-second. The escape codes are dead
 * standard and `process.stderr.isTTY` is enough to detect unsupported
 * terminals (CI logs, pipes, redirected stdout).
 */
const isTTY = process.stderr.isTTY === true;
const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor = isTTY && !noColor;

function paint(code: string, text: string): string {
    if (!useColor) return text;
    return `\u001B[${code}m${text}\u001B[0m`;
}

export const c = {
    bold: (s: string) => paint('1', s),
    dim: (s: string) => paint('2', s),
    red: (s: string) => paint('31', s),
    green: (s: string) => paint('32', s),
    yellow: (s: string) => paint('33', s),
    blue: (s: string) => paint('34', s),
    cyan: (s: string) => paint('36', s),
};

export const log = {
    info(msg: string): void { process.stderr.write(`${msg}\n`); },
    success(msg: string): void { process.stderr.write(`${c.green('✓')} ${msg}\n`); },
    warn(msg: string): void { process.stderr.write(`${c.yellow('!')} ${msg}\n`); },
    error(msg: string): void { process.stderr.write(`${c.red('✗')} ${msg}\n`); },
    detail(msg: string): void { process.stderr.write(`${c.dim(msg)}\n`); },
    raw(msg: string): void { process.stderr.write(msg); },
    /** Print a structured JSON payload to STDOUT (for `--json`). Always last. */
    json(payload: unknown): void {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    },
};
