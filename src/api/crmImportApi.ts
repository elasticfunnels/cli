import * as path from 'path';
import { ApiClient, httpError } from './client';
import { CliError, ExitCode } from '../utils/exit';
import { multipart } from './kitContextApi';

/**
 * CRM file import (app: Modules/CRM CrmImportController, T1111-1).
 *   POST /api/brands/{brand}/crm/entities/{entity}/import/preview  multipart `file`
 *   POST /api/brands/{brand}/crm/entities/{entity}/import/rows     JSON, chunked by offset/limit
 * The server keeps the parsed file for a day under its hash; rows import is NOT
 * idempotent (the same offset twice imports twice).
 */

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_CHUNK = 250;

export interface ImportSuggestion { label: string; key: string; type: string; options?: Array<{ label: string; value: string }> | null }

export interface ImportColumn {
    index: number;
    header: string;
    samples: string[];
    choices: string[] | null;
    filled: number;
    action: 'create' | 'existing' | 'skip';
    existing_key: string | null;
    suggested: ImportSuggestion;
}

export interface ImportPreview {
    file_hash: string;
    file_name: string;
    row_count: number;
    title_column: number | null;
    columns: ImportColumn[];
    sample_rows: string[][];
}

export interface ImportRowsBody {
    file_hash: string;
    mapping: Array<{ index: number; key: string }>;
    title_column?: number | null;
    pipeline_id?: number;
    stage_id?: number;
    offset: number;
    limit: number;
}

export interface ImportRowsResult {
    imported: number;
    skipped: number;
    failed: number;
    errors: Array<{ row: number; message: string }>;
    next_offset: number;
    total: number;
    done: boolean;
}

const MIME: Record<string, string> = {
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function importMime(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.xls' || ext === '.numbers') {
        throw new CliError(ExitCode.Validation, `Old .xls and Numbers files can't be read. Save "${fileName}" as .xlsx or .csv and try again.`);
    }
    const mime = MIME[ext];
    if (!mime) throw new CliError(ExitCode.Validation, `Import takes a .csv, .tsv, .txt or .xlsx file, got "${fileName}".`);
    return mime;
}

function base(brandId: number, entityId: number): string {
    return `/api/brands/${brandId}/crm/entities/${entityId}/import`;
}

export async function previewImport(api: ApiClient, brandId: number, entityId: number, file: { name: string; bytes: Uint8Array }): Promise<ImportPreview> {
    const mime = importMime(file.name);
    if (file.bytes.byteLength > IMPORT_MAX_BYTES) throw new CliError(ExitCode.Validation, `"${file.name}" is over 20 MB. Split it into smaller files.`);
    const mp = multipart({}, { field: 'file', name: file.name, mime, bytes: file.bytes });
    const res = await api.request('POST', `${base(brandId, entityId)}/preview`, { headers: { 'Content-Type': mp.contentType }, data: mp.body });
    if (res.status >= 400) throw httpError('Read import file', res);
    const d = res.data as ImportPreview;
    if (!d || typeof d.file_hash !== 'string' || !Array.isArray(d.columns)) throw new CliError(ExitCode.Server, 'The import preview came back without a file hash or columns.');
    return d;
}

export async function importRows(api: ApiClient, brandId: number, entityId: number, body: ImportRowsBody): Promise<ImportRowsResult> {
    const res = await api.request('POST', `${base(brandId, entityId)}/rows`, { data: body });
    if (res.status >= 400) throw httpError(`Import rows from offset ${body.offset}`, res);
    const d = res.data as Partial<ImportRowsResult>;
    return {
        imported: Number(d.imported ?? 0),
        skipped: Number(d.skipped ?? 0),
        failed: Number(d.failed ?? 0),
        errors: Array.isArray(d.errors) ? d.errors : [],
        next_offset: Number(d.next_offset ?? body.offset + body.limit),
        total: Number(d.total ?? 0),
        done: d.done === true,
    };
}
