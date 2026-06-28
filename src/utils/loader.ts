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

/** >0 while a full funnel `loader()` owns stderr — suppresses the request bar. */
let commandLoaders = 0;

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

export function loader(label = 'Syncing'): { update: (label: string) => void; stop: (final?: string) => void } {
    let current = label;
    // This loader owns stderr; clear any in-flight request bar and suppress new
    // ones until we stop, so the two never fight over the line.
    commandLoaders++;
    stopBarRender();
    if (!animate) {
        process.stderr.write(`${current}…\n`);
        return {
            update: () => {},
            stop: (final?: string) => {
                commandLoaders = Math.max(0, commandLoaders - 1);
                if (final) process.stderr.write(`${final}\n`);
            },
        };
    }
    let tick = 0;
    process.stderr.write(`${ESC}[?25l${'\n'.repeat(ROWS + 1)}`); // hide cursor, reserve rows
    const draw = () => {
        process.stderr.write(`${ESC}[${ROWS + 1}A\r${frame((tick % 25) / 24, current, tick)}\n`);
        tick++;
    };
    draw();
    const timer = setInterval(draw, 55);
    timer.unref?.();
    return {
        update: (l: string) => { current = l; },
        stop: (final?: string) => {
            clearInterval(timer);
            commandLoaders = Math.max(0, commandLoaders - 1);
            // Back to the top of the block, clear it, restore the cursor.
            process.stderr.write(`${ESC}[${ROWS + 1}A\r${ESC}[J${ESC}[?25h`);
            if (final) process.stderr.write(`${final}\n`);
        },
    };
}

// ── Per-request activity bar ─────────────────────────────────────────────────
// A colored block bar shown while API requests are in flight, for the many
// commands that don't run the full funnel loader (list/get/push/create/…). It's
// refcounted so concurrent requests share one bar, starts after a short delay so
// fast requests don't flicker, renders to stderr (stdout stays clean for
// `--json`), and is suppressed while a funnel `loader()` owns the screen.

const BAR_WIDTH = 24;
let inflight = 0;
let barTimer: ReturnType<typeof setInterval> | null = null;
let barStartTimer: ReturnType<typeof setTimeout> | null = null;
let barDrawn = false;

function drawBar(tick: number): void {
    const pos = tick % BAR_WIDTH;
    const cells: string[] = [];
    for (let i = 0; i < BAR_WIDTH; i++) {
        const raw = Math.abs(i - pos);
        const dist = Math.min(raw, BAR_WIDTH - raw); // wrap so the band loops smoothly
        const boost = Math.max(0, 1 - dist / 3.2);
        cells.push(`${orangeAt(0.28 + 0.72 * boost)}▀`);
    }
    process.stderr.write(`\r  ${cells.join('')}${ESC}[0m${ESC}[K`);
    barDrawn = true;
}

function stopBarRender(): void {
    if (barStartTimer) { clearTimeout(barStartTimer); barStartTimer = null; }
    if (barTimer) { clearInterval(barTimer); barTimer = null; }
    if (barDrawn) { process.stderr.write(`\r${ESC}[K`); barDrawn = false; }
}

/** An API request started. Starts the shared bar on the first in-flight request. */
export function requestStart(): void {
    inflight++;
    if (inflight !== 1 || !animate || commandLoaders > 0 || barStartTimer || barTimer) return;
    let tick = 0;
    barStartTimer = setTimeout(() => {
        barStartTimer = null;
        drawBar(tick++);
        barTimer = setInterval(() => drawBar(tick++), 60);
        barTimer.unref?.();
    }, 120);
    barStartTimer.unref?.();
}

/** An API request settled. Stops the bar when nothing is in flight. */
export function requestEnd(): void {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) stopBarRender();
}
