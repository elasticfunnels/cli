export interface Asset {
    id: number;
    file_name: string;
    file_path: string;
    size?: number | null;
    updated_at?: string | null;
}

export interface AssetEditorPayload {
    id: number;
    html?: string;
    language?: string;
    is_binary?: boolean;
    file_name?: string;
    file_path?: string;
    content_base64?: string;
    updated_at?: string;
    size?: number | null;
    error?: string;
}

/** Stub to mark the placeholder body for a binary asset opened in the
 *  text editor — same string the Laravel backend uses. Mirrors the
 *  vscode-extension constant. */
export const BINARY_EDITOR_STUB_LINE =
    '// This is a binary file and cannot be edited in the text editor';

/** True if the API returned a placeholder rather than usable bytes for the
 *  asset (binary file with no `content_base64`, or a stub `html` line). */
export function needsLocalAssetFallback(payload: AssetEditorPayload): boolean {
    if (payload.content_base64 && payload.content_base64.length > 0) {
        const decoded = Buffer.from(payload.content_base64, 'base64');
        const asText = decoded.toString('utf8').trim();
        return asText === BINARY_EDITOR_STUB_LINE;
    }
    const html = (payload.html ?? '').trim();
    if (html === BINARY_EDITOR_STUB_LINE) return true;
    if (payload.is_binary === true) return true;
    return false;
}

export function assetEditorPayloadToBuffer(payload: AssetEditorPayload): Buffer {
    if (payload.content_base64 && payload.content_base64.length > 0) {
        return Buffer.from(payload.content_base64, 'base64');
    }
    return Buffer.from(payload.html ?? '', 'utf8');
}
