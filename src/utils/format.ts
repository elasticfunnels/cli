import { c } from './log';

/**
 * Tiny printable table. Truncates long cells so a single row never
 * wraps the terminal in a way that destroys legibility, and right-pads
 * cells per column for vertical alignment. We accept a `human` /
 * `json` mode toggle from the command, but tables are only used in
 * human mode — JSON-mode commands print structured payloads instead.
 */
export interface TableOptions {
    /** Header labels. Length determines the number of columns. */
    head: string[];
    /** Row data. Each row's cells must align with `head` length. */
    rows: Array<string[]>;
    /** Maximum width of any cell before truncation. Default: 80. */
    maxCellWidth?: number;
}

export function renderTable(opts: TableOptions): string {
    const max = opts.maxCellWidth ?? 80;
    const head = opts.head.map(h => truncate(h, max));
    const rows = opts.rows.map(row => row.map(cell => truncate(cell ?? '', max)));
    const cols = head.length;

    const widths: number[] = [];
    for (let i = 0; i < cols; i++) {
        widths[i] = head[i].length;
        for (const row of rows) {
            widths[i] = Math.max(widths[i], (row[i] ?? '').length);
        }
    }

    const fmt = (cells: string[]): string =>
        cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');

    const lines: string[] = [];
    lines.push(c.bold(fmt(head)));
    lines.push(c.dim(fmt(widths.map(w => '-'.repeat(w)))));
    for (const row of rows) {
        lines.push(fmt(row));
    }
    return lines.join('\n');
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function formatBytes(n: number | null | undefined): string {
    if (n == null) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatRelative(iso?: string | null): string {
    if (!iso) return '-';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    if (diff < 0) return new Date(t).toLocaleString();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 48) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(t).toLocaleDateString();
}
