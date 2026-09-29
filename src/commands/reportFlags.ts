import { Command } from 'commander';
import { CliError, ExitCode } from '../utils/exit';
import { RANGE_PRESETS, ResolvedRange, resolveRange } from '../utils/dateRange';
import { EfRuntime } from '../utils/store';

/**
 * Flags shared by the read-only record listings (`ef orders`, `ef sessions`).
 * The date range resolves exactly like `ef stats` — same presets, same
 * `--tz` > `analyticsTz` > machine-zone order — so a count here lines up with
 * the dashboard figure for the same days.
 */
export interface RangeFlags {
    range?: string;
    from?: string;
    to?: string;
    tz?: string;
}

export function withRangeFlags(cmd: Command, defaultRange = '7d'): Command {
    return cmd
        .option('-r, --range <preset>', `Named range: ${RANGE_PRESETS.join(', ')}, or <n>d. Default: ${defaultRange}.`)
        .option('--from <date>', 'First day, YYYY-MM-DD. Overrides --range.')
        .option('--to <date>', 'Last day, YYYY-MM-DD. Defaults to today.')
        .option('--tz <zone>', 'IANA timezone the days are counted in. Defaults to analyticsTz, else this machine\'s.');
}

export function resolveReportRange(rt: EfRuntime, opts: RangeFlags, defaultRange = '7d'): ResolvedRange {
    const withDefault = (opts.from || opts.to || opts.range) ? opts : { ...opts, range: defaultRange };
    return resolveRange(withDefault, rt.config.analyticsTz);
}

/** `--funnel 12` → 12; junk is a usage error rather than a silently unfiltered list. */
export function idFlag(name: string, raw: string | undefined): number | undefined {
    if (raw == null) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new CliError(ExitCode.Validation, `--${name} takes a numeric id. Got "${raw}".`);
    }
    return n;
}

export function positiveInt(name: string, raw: string | undefined, fallback: number): number {
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        throw new CliError(ExitCode.Validation, `--${name} takes a positive integer. Got "${raw}".`);
    }
    return n;
}

/** `2026-09-28T20:18:18-04:00` → `2026-09-28 20:18` in `tz`. */
export function formatInTz(iso: string | null | undefined, tz: string, withSeconds = false): string {
    if (!iso) return '-';
    const t = Date.parse(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(t)) return iso;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hourCycle: 'h23',
    }).formatToParts(new Date(t));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}${withSeconds ? ':' + get('second') : ''}`;
}
