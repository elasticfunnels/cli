// Audiences (SegQL segments) and email / SMS campaign endpoints for `ef audiences` and `ef campaigns`.
//
// Everything is under /api/brands/{brand}/ with the caller's EF-Access-Key, so the app applies the same
// policies as the web screens (analytics.view + segments.*, emails.*, SMS integrations.*). Contact PII in
// samples and recipient lists comes back masked when the key's user lacks contacts.view_pii.
import { AxiosResponse } from 'axios';
import { ApiClient, httpError } from './client';
import { CliError, ExitCode } from '../utils/exit';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export async function call<T = any>(
    api: ApiClient,
    method: Method,
    url: string,
    label: string,
    opts?: { params?: Record<string, unknown>; data?: unknown },
): Promise<T> {
    const res = await api.request(method, url, opts);
    if (res.status >= 400) throw apiError(label, res);
    return res.data as T;
}

/** A SegQL parse/validation error (400 {error, message}) or a campaign launch code becomes a readable CLI error. */
export function apiError(label: string, res: AxiosResponse): CliError {
    const data = (res.data ?? {}) as { error?: string; code?: string; message?: string; problems?: unknown; readiness?: unknown };
    if (res.status === 400 && (data.error === 'parse' || data.error === 'validation')) {
        return new CliError(ExitCode.Validation, `SegQL ${data.error} error: ${data.message ?? 'invalid'}`);
    }
    if (res.status === 422 && data.code) {
        const hint = LAUNCH_HINTS[data.code];
        const problems = Array.isArray(data.problems) ? ` (${data.problems.map(problemText).join(', ')})` : '';
        return new CliError(ExitCode.Validation, `${label} refused: ${hint ?? data.code}${problems}`);
    }
    if (res.status === 422 && Array.isArray(data.readiness)) {
        return new CliError(ExitCode.Validation, `${label} refused: ${data.readiness.map(problemText).join('; ')}`);
    }
    if (res.status === 409 && data.code) {
        return new CliError(ExitCode.Conflict, `${label} refused: ${data.message ?? data.code}`);
    }
    if (res.status === 404 && /email-campaigns|sms\/campaigns/.test(String(res.config?.url ?? '')) && !data.message) {
        return new CliError(ExitCode.NotFound, `${label} failed (HTTP 404): not found, or campaigns are not enabled for this brand.`);
    }
    return httpError(label, res);
}

function problemText(p: unknown): string {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
        const o = p as { code?: string; message?: string };
        return o.message ?? o.code ?? JSON.stringify(p);
    }
    return String(p);
}

const LAUNCH_HINTS: Record<string, string> = {
    not_ready: 'the campaign is not ready',
    test_required: 'send a test first (ef campaigns email test <id>) or pass --skip-test',
    schedule_in_past: 'the schedule time must be more than a minute ahead',
    not_launchable: 'only draft or queued campaigns can be launched',
    not_editable: 'only drafts can be edited (unschedule it first)',
    cancel_first: 'cancel the campaign before deleting it',
};

const seg = (b: number, p = '') => `/api/brands/${b}/analytics/segments${p}`;
const email = (b: number, p = '') => `/api/brands/${b}/email-campaigns${p}`;
const sms = (b: number, p = '') => `/api/brands/${b}/sms/campaigns${p}`;

// ── Audiences ───────────────────────────────────────────────────────────
export const audiences = {
    list: (api: ApiClient, b: number) => call<any[]>(api, 'GET', seg(b), 'List audiences'),
    get: (api: ApiClient, b: number, id: number) => call(api, 'GET', seg(b, `/${id}`), 'Get audience'),
    validate: (api: ApiClient, b: number, segql: string) => call<{ valid: boolean; identity_column: string }>(api, 'POST', seg(b, '/validate-segql'), 'Validate SegQL', { data: { segql } }),
    preview: (api: ApiClient, b: number, segql: string, sampleSize: number, members: boolean) =>
        call(api, 'POST', seg(b, '/preview-segql'), 'Count SegQL', { data: { segql, sample_size: sampleSize, members } }),
    schema: (api: ApiClient, b: number) => call(api, 'GET', seg(b, '/segql-schema'), 'SegQL schema'),
    create: (api: ApiClient, b: number, data: Record<string, unknown>) => call(api, 'POST', seg(b, '/compile-and-save-segql'), 'Create audience', { data }),
    update: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'PUT', seg(b, `/${id}`), 'Update audience', { data }),
    updateSegql: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'PUT', seg(b, `/${id}/segql`), 'Update audience SegQL', { data }),
    remove: (api: ApiClient, b: number, id: number) => call(api, 'DELETE', seg(b, `/${id}`), 'Delete audience'),
    recompute: (api: ApiClient, b: number, id: number) => call(api, 'POST', seg(b, `/${id}/recompute`), 'Recompute audience'),
    members: (api: ApiClient, b: number, id: number, params: Record<string, unknown>) => call(api, 'GET', seg(b, `/${id}/members`), 'Audience members', { params }),
};

// ── Email campaigns ─────────────────────────────────────────────────────
export const emailCampaigns = {
    list: (api: ApiClient, b: number, params: Record<string, unknown>) => call(api, 'GET', email(b), 'List email campaigns', { params }),
    get: (api: ApiClient, b: number, id: number) => call(api, 'GET', email(b, `/${id}`), 'Get email campaign'),
    create: (api: ApiClient, b: number, data: Record<string, unknown>) => call(api, 'POST', email(b), 'Create email campaign', { data }),
    update: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'PUT', email(b, `/${id}`), 'Update email campaign', { data }),
    remove: (api: ApiClient, b: number, id: number) => call(api, 'DELETE', email(b, `/${id}`), 'Delete email campaign'),
    setContent: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'POST', email(b, `/${id}/content`), 'Set email content', { data }),
    previewAudience: (api: ApiClient, b: number, data: Record<string, unknown>) => call(api, 'POST', email(b, '/preview-audience'), 'Preview email audience', { data }),
    sendTest: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'POST', email(b, `/${id}/send-test`), 'Send test email', { data }),
    launch: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'POST', email(b, `/${id}/launch`), 'Launch email campaign', { data }),
    unschedule: (api: ApiClient, b: number, id: number) => call(api, 'POST', email(b, `/${id}/unschedule`), 'Unschedule email campaign'),
    cancel: (api: ApiClient, b: number, id: number) => call(api, 'POST', email(b, `/${id}/cancel`), 'Cancel email campaign'),
    report: (api: ApiClient, b: number, id: number) => call(api, 'GET', email(b, `/${id}/report`), 'Email campaign report'),
    recipients: (api: ApiClient, b: number, id: number, params: Record<string, unknown>) => call(api, 'GET', email(b, `/${id}/recipients`), 'Email campaign recipients', { params }),
};

// ── SMS campaigns ───────────────────────────────────────────────────────
export const smsCampaigns = {
    list: (api: ApiClient, b: number, params: Record<string, unknown>) => call(api, 'GET', sms(b), 'List SMS campaigns', { params }),
    get: (api: ApiClient, b: number, id: number) => call(api, 'GET', sms(b, `/${id}`), 'Get SMS campaign'),
    create: (api: ApiClient, b: number, data: Record<string, unknown>) => call(api, 'POST', sms(b), 'Create SMS campaign', { data }),
    update: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'PUT', sms(b, `/${id}`), 'Update SMS campaign', { data }),
    remove: (api: ApiClient, b: number, id: number) => call(api, 'DELETE', sms(b, `/${id}`), 'Delete SMS campaign'),
    previewAudience: (api: ApiClient, b: number, data: Record<string, unknown>) => call(api, 'POST', sms(b, '/preview-audience'), 'Preview SMS audience', { data }),
    preview: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'POST', sms(b, `/${id}/preview`), 'Preview SMS text', { data }),
    sendTest: (api: ApiClient, b: number, id: number, phone: string) => call(api, 'POST', sms(b, `/${id}/send-test`), 'Send test SMS', { data: { phone } }),
    launch: (api: ApiClient, b: number, id: number, data: Record<string, unknown>) => call(api, 'POST', sms(b, `/${id}/launch`), 'Launch SMS campaign', { data }),
    transition: (api: ApiClient, b: number, id: number, action: 'unschedule' | 'pause' | 'resume' | 'cancel') => call(api, 'POST', sms(b, `/${id}/${action}`), `${action} SMS campaign`),
    report: (api: ApiClient, b: number, id: number) => call(api, 'GET', sms(b, `/${id}/report`), 'SMS campaign report'),
    recipients: (api: ApiClient, b: number, id: number, params: Record<string, unknown>) => call(api, 'GET', sms(b, `/${id}/recipients`), 'SMS campaign recipients', { params }),
};
