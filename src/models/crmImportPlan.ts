import { CliError, ExitCode } from '../utils/exit';
import type { ImportColumn, ImportPreview, ImportSuggestion } from '../api/crmImportApi';

/**
 * Turn the server's per-column suggestion into what `ef crm import` will do:
 * which columns map to an existing field, which need a new field first, and
 * which are left out. Pure, so the decisions can be tested without a server.
 */

export interface PlanColumn {
    index: number;
    header: string;
    action: 'existing' | 'create' | 'skip';
    key: string | null;
    /** Field to create (action create only). */
    field?: ImportSuggestion;
    samples: string[];
}

export interface ImportPlan {
    columns: PlanColumn[];
    mapping: Array<{ index: number; key: string }>;
    create: ImportSuggestion[];
    titleColumn: number | null;
}

export interface PlanOverrides {
    /** "Column=key" pairs: map a column to this field key (existing, or created with the suggested type). */
    map?: string[];
    /** Columns to leave out. */
    skip?: string[];
    /** Column used for each entry's title. */
    title?: string;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,127}$/;

/** Find a column by its 0-based index or its header (case-insensitive). */
export function findColumn(columns: ImportColumn[], ref: string): ImportColumn {
    const r = ref.trim();
    if (/^\d+$/.test(r)) {
        const hit = columns.find((c) => c.index === parseInt(r, 10));
        if (hit) return hit;
    }
    const lower = r.toLowerCase();
    const hit = columns.find((c) => (c.header ?? '').trim().toLowerCase() === lower);
    if (!hit) {
        const list = columns.map((c) => `${c.index}:"${c.header}"`).join(', ');
        throw new CliError(ExitCode.Validation, `No column "${ref}" in the file. Columns: ${list}.`);
    }
    return hit;
}

export function buildImportPlan(preview: ImportPreview, existingKeys: Set<string>, o: PlanOverrides = {}): ImportPlan {
    const mapTo = new Map<number, string>();
    for (const pair of o.map ?? []) {
        const eq = pair.lastIndexOf('=');
        if (eq <= 0 || eq === pair.length - 1) throw new CliError(ExitCode.Validation, `--map takes "Column=field_key", got "${pair}".`);
        const col = findColumn(preview.columns, pair.slice(0, eq));
        const key = pair.slice(eq + 1).trim();
        if (!KEY_RE.test(key)) throw new CliError(ExitCode.Validation, `Field key "${key}" must be lowercase letters, digits and _ and start with a letter.`);
        mapTo.set(col.index, key);
    }
    const skip = new Set<number>((o.skip ?? []).map((s) => findColumn(preview.columns, s).index));
    for (const i of skip) {
        if (mapTo.has(i)) throw new CliError(ExitCode.Validation, `Column ${i} is in both --map and --skip.`);
    }

    const columns: PlanColumn[] = preview.columns.map((c) => {
        const samples = (c.samples ?? []).slice(0, 3);
        if (skip.has(c.index)) return { index: c.index, header: c.header, action: 'skip', key: null, samples };
        const forced = mapTo.get(c.index);
        if (forced) {
            if (existingKeys.has(forced)) return { index: c.index, header: c.header, action: 'existing', key: forced, samples };
            const field = { ...c.suggested, key: forced, label: c.suggested?.label || c.header };
            return { index: c.index, header: c.header, action: 'create', key: forced, field, samples };
        }
        if (c.action === 'skip') return { index: c.index, header: c.header, action: 'skip', key: null, samples };
        if (c.action === 'existing' && c.existing_key) return { index: c.index, header: c.header, action: 'existing', key: c.existing_key, samples };
        const key = c.suggested?.key;
        if (!key) return { index: c.index, header: c.header, action: 'skip', key: null, samples };
        // The suggestion may already exist (created by an earlier run of this import).
        if (existingKeys.has(key)) return { index: c.index, header: c.header, action: 'existing', key, samples };
        return { index: c.index, header: c.header, action: 'create', key, field: c.suggested, samples };
    });

    const seen = new Map<string, string>();
    for (const c of columns) {
        if (!c.key) continue;
        const prev = seen.get(c.key);
        if (prev != null) throw new CliError(ExitCode.Validation, `Columns "${prev}" and "${c.header}" both map to field "${c.key}". Use --map or --skip on one of them.`);
        seen.set(c.key, c.header);
    }

    const mapping = columns.filter((c) => c.key).map((c) => ({ index: c.index, key: c.key as string }));
    if (!mapping.length) throw new CliError(ExitCode.Validation, 'Every column is skipped: nothing to import.');
    const create = columns.filter((c) => c.action === 'create' && c.field).map((c) => c.field as ImportSuggestion);
    const titleColumn = o.title != null ? findColumn(preview.columns, o.title).index : preview.title_column ?? null;
    return { columns, mapping, create, titleColumn };
}
