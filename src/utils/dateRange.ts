import { CliError, ExitCode } from './exit';

/**
 * Date-range resolution for `ef stats`.
 *
 * Two things about the analytics API shape this module:
 *
 * 1. It parses `start`/`end` as calendar days and throws the time part away
 *    (`explode('T')` server-side) unless a caller opts into time. So we send
 *    plain `YYYY-MM-DD` — sending an ISO instant would imply a precision the
 *    endpoint does not have, and invites the "why is 04:00Z a different day"
 *    class of bug.
 *
 * 2. `tz` is what turns those days into instants, and when it is absent the
 *    server falls back to `America/Los_Angeles` — *not* to the brand's own
 *    timezone. A brand in Bucharest that omits `tz` gets LA days silently. So
 *    the CLI always sends one explicitly, defaulting to the machine's zone.
 */

export interface ResolvedRange {
    /** Inclusive first day, `YYYY-MM-DD`. */
    start: string;
    /** Inclusive last day, `YYYY-MM-DD`. */
    end: string;
    /** IANA zone the days are interpreted in. */
    tz: string;
    /** How the range was described, for the human header ("last 7 days"). */
    label: string;
}

/** Named ranges accepted by `--range`, in the order `--help` lists them. */
export const RANGE_PRESETS = [
    'today', 'yesterday', '7d', '14d', '30d', '90d', 'mtd', 'qtd', 'ytd',
] as const;

export type RangePreset = typeof RANGE_PRESETS[number];

/**
 * The machine's IANA zone, or UTC when the runtime cannot say.
 *
 * `Intl` is the only source that gets this right across platforms; `TZ` is
 * unset on most desktops and `getTimezoneOffset()` gives a number, not a zone,
 * so it cannot express DST rules the server needs to bucket days by.
 */
export function systemTimezone(): string {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return tz && tz.length > 0 ? tz : 'UTC';
    } catch {
        return 'UTC';
    }
}

/** Whether a string is a zone this runtime knows. Cheap guard for `--tz`. */
export function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * "Now", as the calendar day it is in `tz`.
 *
 * Formatting through `Intl` rather than shifting a UTC timestamp by a fixed
 * offset, because the offset is only knowable per-instant once DST exists.
 */
export function todayInTz(tz: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    // en-CA already yields YYYY-MM-DD; normalise separators defensively.
    return parts.replace(/\//g, '-');
}

/**
 * Calendar arithmetic on a plain `YYYY-MM-DD`.
 *
 * Anchored at UTC noon so that adding days can never cross a boundary through
 * a DST transition — the classic "subtract 1 day, land on the same day" bug.
 * The result is a date string, so no instant escapes this function.
 */
export function addDays(day: string, delta: number): string {
    const [y, m, d] = day.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d, 12, 0, 0) + delta * 86400000;
    return new Date(t).toISOString().slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate and normalise a user-supplied `--from` / `--to`. */
function parseDay(flag: string, raw: string): string {
    const v = raw.trim();
    if (!DAY_RE.test(v)) {
        throw new CliError(ExitCode.Validation, `${flag} must be a date as YYYY-MM-DD. Got "${raw}".`);
    }
    const [y, m, d] = v.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d, 12));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
        throw new CliError(ExitCode.Validation, `${flag} is not a real date: "${raw}".`);
    }
    return v;
}

export interface RangeOptions {
    from?: string;
    to?: string;
    range?: string;
    tz?: string;
}

/**
 * Turn the range flags into the two days and the zone we send.
 *
 * `--from`/`--to` win over `--range`; either bound alone is allowed and the
 * other defaults (a lone `--from` runs to today, a lone `--to` starts there).
 * With nothing given at all the default is the last 7 days including today,
 * which is the range the dashboard opens on.
 */
export function resolveRange(opts: RangeOptions, configTz?: string | null): ResolvedRange {
    const tz = resolveTz(opts.tz, configTz);
    const today = todayInTz(tz);

    if (opts.from || opts.to) {
        if (opts.range) {
            throw new CliError(ExitCode.Validation, 'Use either --range or --from/--to, not both.');
        }
        const start = opts.from ? parseDay('--from', opts.from) : (opts.to ? parseDay('--to', opts.to) : today);
        const end = opts.to ? parseDay('--to', opts.to) : today;
        if (start > end) {
            throw new CliError(ExitCode.Validation, `--from (${start}) is after --to (${end}).`);
        }
        return { start, end, tz, label: start === end ? start : `${start} → ${end}` };
    }

    const preset = (opts.range ?? '7d').trim().toLowerCase();
    switch (preset) {
        case 'today':
            return { start: today, end: today, tz, label: 'today' };
        case 'yesterday': {
            const y = addDays(today, -1);
            return { start: y, end: y, tz, label: 'yesterday' };
        }
        case 'mtd':
            return { start: today.slice(0, 8) + '01', end: today, tz, label: 'month to date' };
        case 'qtd': {
            const month = Number(today.slice(5, 7));
            const firstMonth = month - ((month - 1) % 3);
            const start = `${today.slice(0, 4)}-${String(firstMonth).padStart(2, '0')}-01`;
            return { start, end: today, tz, label: 'quarter to date' };
        }
        case 'ytd':
            return { start: `${today.slice(0, 4)}-01-01`, end: today, tz, label: 'year to date' };
        default: {
            const m = /^(\d+)d$/.exec(preset);
            if (!m) {
                throw new CliError(
                    ExitCode.Validation,
                    `Unknown --range "${opts.range}". Use one of ${RANGE_PRESETS.join(', ')}, or an explicit --from/--to.`,
                );
            }
            const days = Number(m[1]);
            if (days < 1 || days > 3650) {
                throw new CliError(ExitCode.Validation, `--range ${preset} is out of bounds — use 1d to 3650d.`);
            }
            // Inclusive of today, so `7d` is today plus the six before it —
            // seven buckets, matching what the dashboard's "Last 7 days" shows.
            return { start: addDays(today, -(days - 1)), end: today, tz, label: `last ${days} days` };
        }
    }
}

/** `--tz` > `.ef/config.json` > the machine's zone. Validated at each step. */
function resolveTz(flagTz?: string, configTz?: string | null): string {
    if (flagTz) {
        if (!isValidTimezone(flagTz)) {
            throw new CliError(ExitCode.Validation, `--tz "${flagTz}" is not a known IANA timezone (e.g. Europe/Bucharest, UTC).`);
        }
        return flagTz;
    }
    if (configTz && isValidTimezone(configTz)) return configTz;
    return systemTimezone();
}
