/**
 * Terminal loaders. A single colored block-bar (▀) is used both for foreground
 * waits (post-`init` sync, `status`, …) via `loader()` and as a lightweight
 * per-request indicator via `requestStart`/`requestEnd`. Falls back to a static
 * line on a non-TTY / NO_COLOR, and renders to stderr so stdout stays reserved
 * for `--json`.
 */
const ESC = String.fromCharCode(27);
const isTTY = process.stderr.isTTY === true;
const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const animate = isTTY && !noColor;

/** >0 while a foreground `loader()` owns stderr — suppresses the request bar. */
let commandLoaders = 0;

const ORANGE: [number, number, number] = [0xff, 0x5a, 0x36];
const DOTS = ['   ', '.  ', '.. ', '...'];
const BAR_WIDTH = 24;

function orangeAt(scale: number): string {
    const t = Math.min(1, Math.max(0, scale));
    const r = Math.min(255, Math.round(ORANGE[0] * t));
    const g = Math.min(255, Math.round(ORANGE[1] * t));
    const b = Math.min(255, Math.round(ORANGE[2] * t));
    return `${ESC}[38;2;${r};${g};${b}m`;
}

/** One frame of the sweeping block bar: a bright band moves across dim cells. */
function barCells(tick: number, width = BAR_WIDTH): string {
    const pos = tick % width;
    const cells: string[] = [];
    for (let i = 0; i < width; i++) {
        const raw = Math.abs(i - pos);
        const dist = Math.min(raw, width - raw); // wrap so the band loops smoothly
        const boost = Math.max(0, 1 - dist / 3.2);
        cells.push(`${orangeAt(0.28 + 0.72 * boost)}▀`);
    }
    return cells.join('');
}

/**
 * Foreground loader: an animated colored bar with a label, for long waits. Falls
 * back to a single static line when we can't animate.
 */
export function loader(label = 'Syncing'): { update: (label: string) => void; stop: (final?: string) => void } {
    let current = label;
    // This loader owns stderr; clear any request bar and suppress new ones.
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
    process.stderr.write(`${ESC}[?25l`); // hide cursor
    const draw = () => {
        process.stderr.write(`\r  ${barCells(tick)}${ESC}[0m ${orangeAt(1)}${current}${DOTS[Math.floor(tick / 3) % 4]}${ESC}[0m${ESC}[K`);
        tick++;
    };
    draw();
    const timer = setInterval(draw, 60);
    timer.unref?.();
    return {
        update: (l: string) => { current = l; },
        stop: (final?: string) => {
            clearInterval(timer);
            commandLoaders = Math.max(0, commandLoaders - 1);
            process.stderr.write(`\r${ESC}[K${ESC}[?25h`); // clear line, restore cursor
            if (final) process.stderr.write(`${final}\n`);
        },
    };
}

// ── Per-request activity bar ─────────────────────────────────────────────────
// The same bar, shown while API requests are in flight for commands that don't
// run a foreground loader() (list/get/push/create/…). Refcounted so concurrent
// requests share one bar, started after a short delay so fast requests don't
// flicker, and suppressed while a loader() owns the screen.

let inflight = 0;
let barTimer: ReturnType<typeof setInterval> | null = null;
let barStartTimer: ReturnType<typeof setTimeout> | null = null;
let barDrawn = false;

function drawBar(tick: number): void {
    process.stderr.write(`\r  ${barCells(tick)}${ESC}[0m${ESC}[K`);
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
