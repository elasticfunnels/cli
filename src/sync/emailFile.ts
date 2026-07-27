// On-disk format for emails: `emails/<code>.html` = a one-line identity/metadata
// front-matter HTML comment, followed by the raw email HTML body. The comment is
// stripped before the body is sent to the server and re-added on pull, so it
// never ships inside the actual email. css + the GrapesJS `config` graph are
// server-managed (preserved verbatim on push), not stored on disk.

import { BrandEmail } from '../api/types';

export interface EmailMeta {
    v?: number;
    id?: number;
    code?: string;
    name?: string;
    subject?: string;
    preview_text?: string;
    from_name?: string;
    from_email?: string;
    reply_to_email?: string;
    variable_scope?: string;
    /** Server `updated_at` at last pull/push — drift baseline (server-newer check). */
    remoteUpdatedAt?: string;
    /** sha256 of the body at last pull/push — drift baseline (local-edit check). */
    baseHash?: string;
}

// Matches the line-1 front-matter. Non-greedy up to the `} -->` that really
// closes it, so a `}` inside a subject string doesn't end it early.
const EFEMAIL_RE = /^<!--\s*efemail:\s*(\{[\s\S]*?\})\s*-->[^\n]*\r?\n?/;

/** Ordered keys so the serialized front-matter is stable across writes. */
const META_ORDER: (keyof EmailMeta)[] = ['v', 'id', 'code', 'name', 'subject', 'preview_text', 'from_name', 'from_email', 'reply_to_email', 'variable_scope', 'remoteUpdatedAt', 'baseHash'];

export function parseEmailFile(text: string): { meta: EmailMeta; body: string } {
    const m = EFEMAIL_RE.exec(text);
    if (!m) return { meta: {}, body: text };
    let meta: EmailMeta = {};
    try { meta = JSON.parse(m[1]) as EmailMeta; } catch { meta = {}; }
    return { meta, body: text.slice(m[0].length) };
}

/** JSON for the front-matter comment, dropping empty/undefined fields. */
export function serializeEmailMeta(meta: EmailMeta): string {
    const obj: Record<string, unknown> = {};
    for (const k of META_ORDER) {
        const val = meta[k];
        if (val !== undefined && val !== null && val !== '') obj[k] = val;
    }
    return JSON.stringify(obj);
}

export function serializeEmailFile(meta: EmailMeta, body: string): string {
    const fm = `<!-- efemail:${serializeEmailMeta(meta)} -->`;
    const b = body.startsWith('\n') ? body : `\n${body}`;
    return `${fm}${b}`;
}

/** Build the on-disk metadata from a server email. */
export function metaFromEmail(email: BrandEmail): EmailMeta {
    return {
        v: 1,
        id: email.id,
        code: email.code ?? undefined,
        name: email.name ?? undefined,
        subject: email.subject ?? undefined,
        preview_text: email.preview_text ?? undefined,
        from_name: email.from_name ?? undefined,
        from_email: email.from_email ?? undefined,
        reply_to_email: email.reply_to_email ?? undefined,
        variable_scope: email.variable_scope ?? undefined,
    };
}

/** The metadata payload the create/update endpoints accept (drops empties). */
export function metaToPayload(meta: EmailMeta, fallbackCode: string): Record<string, unknown> {
    const code = (meta.code && meta.code.trim() !== '') ? meta.code : fallbackCode;
    const out: Record<string, unknown> = { code, name: meta.name ?? code };
    const optional: (keyof EmailMeta)[] = ['subject', 'preview_text', 'from_name', 'from_email', 'reply_to_email', 'variable_scope'];
    for (const k of optional) {
        const v = meta[k];
        if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
}

/** `emails/<code>.html` (falls back to the id when the email has no code). */
export function relPathForEmail(email: { code?: string | null; id: number }): string {
    const base = (email.code && email.code.trim() !== '') ? email.code : String(email.id);
    return `emails/${sanitizeCode(base)}.html`;
}

/** Filesystem-safe form of a code for use as a filename. */
export function sanitizeCode(code: string): string {
    return code.replace(/[^a-zA-Z0-9._-]+/g, '-');
}
