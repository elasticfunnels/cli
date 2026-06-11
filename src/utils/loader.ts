/**
 * Animated ElasticFunnels logo loader for long waits (the post-`init` sync,
 * `status`, …). A brighter orange band pulses down the funnel while `label`
 * animates with trailing dots.
 *
 * The funnel art is precomputed braille — the shape never changes, only the
 * colour band moves — so the CLI ships no SVG rasterizer. (Regenerate with
 * `node ef-loader.mjs --debug` if the logo ever changes.)
 *
 * Falls back to a single static line on a non-TTY / NO_COLOR, and renders to
 * stderr so stdout stays reserved for `--json`.
 */
const ESC = String.fromCharCode(27);
const isTTY = process.stderr.isTTY === true;
const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const animate = isTTY && !noColor;

const ORANGE: [number, number, number] = [0xff, 0x5a, 0x36];

const FUNNEL = [
    '⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏',
    '⢤⣤⣬⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠟⠁⠀',
    '⠀⠙⠓⠒⢲⣶⣶⣶⣶⣶⣶⣶⣶⣶⡶⠀⠀⠀',
    '⠀⠀⠀⢀⣀⣹⣿⣿⣿⣿⣿⣿⡿⠛⠀⠀⠀⠀',
    '⠀⠀⠀⠀⠙⠲⠶⣶⣶⣶⣶⣶⠆⠀⠀⠀⠀⠀',
    '⠀⠀⠀⠀⠀⠀⠀⠈⢿⣿⡿⠃⠀⠀⠀⠀⠀⠀',
];
const ROWS = FUNNEL.length;
const DOTS = ['   ', '.  ', '.. ', '...'];

function orangeAt(scale: number): string {
    const t = Math.min(1, scale);
    const r = Math.min(255, Math.round(ORANGE[0] * t));
    const g = Math.min(255, Math.round(ORANGE[1] * t));
    const b = Math.min(255, Math.round(ORANGE[2] * t));
    return `${ESC}[38;2;${r};${g};${b}m`;
}

function frame(progress: number, label: string, tick: number): string {
    const out: string[] = [];
    for (let r = 0; r < ROWS; r++) {
        const d = ROWS <= 1 ? 0 : r / (ROWS - 1);
        // Solid orange body; a brighter band sweeps downward as the pulse.
        const boost = Math.max(0, 1 - Math.abs(d - progress) * 2.2);
        out.push(`  ${orangeAt(0.78 + 0.22 * boost)}${FUNNEL[r]}${ESC}[0m`);
    }
    out.push(`${orangeAt(1)}  ${label}${DOTS[Math.floor(tick / 3) % 4]}${ESC}[0m${ESC}[K`);
    return out.join('\n');
}

export function loader(label = 'Syncing'): { stop: (final?: string) => void } {
    if (!animate) {
        process.stderr.write(`${label}…\n`);
        return { stop: (final?: string) => { if (final) process.stderr.write(`${final}\n`); } };
    }
    let tick = 0;
    process.stderr.write(`${ESC}[?25l${'\n'.repeat(ROWS + 1)}`); // hide cursor, reserve rows
    const draw = () => {
        process.stderr.write(`${ESC}[${ROWS + 1}A\r${frame((tick % 25) / 24, label, tick)}\n`);
        tick++;
    };
    draw();
    const timer = setInterval(draw, 55);
    timer.unref?.();
    return {
        stop: (final?: string) => {
            clearInterval(timer);
            // Back to the top of the block, clear it, restore the cursor.
            process.stderr.write(`${ESC}[${ROWS + 1}A\r${ESC}[J${ESC}[?25h`);
            if (final) process.stderr.write(`${final}\n`);
        },
    };
}
