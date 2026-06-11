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
const ESC = String.fromCharCode(27);
const isTTY = process.stderr.isTTY === true;
const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor = isTTY && !noColor;

function paint(code: string, text: string): string {
    if (!useColor) return text;
    return `${ESC}[${code}m${text}${ESC}[0m`;
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

/**
 * Lightweight stderr spinner for commands that do network work before they can
 * print anything (e.g. `status`), so the terminal shows activity instead of
 * appearing to hang. On a non-TTY (CI, pipes) it prints a single static line
 * and the returned stop() is a no-op, keeping logs clean.
 */
export function spinner(label: string): { stop: (final?: string) => void } {
    if (!useColor) {
        process.stderr.write(`${label}\n`);
        return { stop: (final?: string) => { if (final) process.stderr.write(`${final}\n`); } };
    }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    process.stderr.write(`${ESC}[?25l`); // hide cursor
    const timer = setInterval(() => {
        i = (i + 1) % frames.length;
        process.stderr.write(`\r${c.cyan(frames[i])} ${label}`);
    }, 80);
    timer.unref?.();
    return {
        stop: (final?: string) => {
            clearInterval(timer);
            process.stderr.write(`\r${ESC}[K${ESC}[?25h`); // clear line, restore cursor
            if (final) process.stderr.write(`${final}\n`);
        },
    };
}
