import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { ContactDetail, ContactRow } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';
import { positiveInt } from './reportFlags';
import { isPiiKey } from '../utils/orders';

/**
 * `ef contacts` — the brand's contacts (leads and buyers, one record per person), read-only.
 *
 * Every subcommand is a GET against the endpoints the Contacts screen uses
 * (`/contacts`, `/contacts/{public_id}`), scoped to this folder's brand by its key.
 *
 * PII, two layers:
 * - The server masks emails, phones, names and postal codes unless the
 *   credential's user holds `contacts.view_pii`.
 * - On top of that, like `ef orders`, the CLI keeps them out of the terminal:
 *   the table never prints them and `--json` drops them unless `--include-pii`.
 */

const LIFECYCLES = ['all', 'customer', 'lead'] as const;
const SORTS = ['newest', 'oldest', 'revenue_high', 'revenue_low', 'orders_high', 'orders_low', 'created_new', 'created_old'] as const;
const EMAIL_STATUSES = ['unknown', 'subscribed', 'unsubscribed', 'suppressed'] as const;
const SMS_STATUSES = ['unknown', 'subscribed', 'unsubscribed'] as const;
const PER_PAGE = 100;
const PUBLIC_ID = /^[0-9A-Za-z]{26}$/;

/**
 * Keys that hold personal data, removed at every depth: the deep match `ef orders` uses (customer_*, billing_*,
 * shipping_*, email, phone, names, address*, zip, postal_code, ...) plus the contact-specific keys below.
 */
const LIST_PII = ['customer_postal_code', 'customer_city', 'customer_state', 'customer_region'];
const DETAIL_PII = ['city', 'state', 'region', 'emails', 'phones', 'consent', 'merges', 'profile_id', 'absorbed_email'];

/** Deep copy of `row` without PII keys (orders' deep match plus `keys`) at any depth. Never mutates the input. */
export function stripContactPii<T extends Record<string, unknown>>(row: T, keys: string[]): Partial<T> {
    const strip = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(strip);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
                if (keys.includes(k) || isPiiKey(k)) continue;
                out[k] = strip(x);
            }
            return out;
        }
        return v;
    };
    return strip(row) as Partial<T>;
}

/** A list row without PII (what `ef contacts list --json` prints without --include-pii). */
export function stripListPii<T extends Record<string, unknown>>(row: T): Partial<T> {
    return stripContactPii(row, LIST_PII);
}

/** The detail record without PII: emails/phones/consent reduced to counts and statuses. */
export function stripDetailPii(c: ContactDetail): Record<string, unknown> {
    const out = stripContactPii(c as unknown as Record<string, unknown>, DETAIL_PII) as Record<string, unknown>;
    out.emails_count = Array.isArray(c.emails) ? c.emails.length : 0;
    out.phones_count = Array.isArray(c.phones) ? c.phones.length : 0;
    out.consent = Array.isArray(c.consent) ? c.consent.map(r => ({ channel: r.channel, status: r.status, source: r.source ?? null, occurred_at: r.occurred_at ?? null })) : [];
    out.merges_count = Array.isArray(c.merges) ? c.merges.length : 0;
    return out;
}

/** One ef_search_contacts row for the MCP agent: name, email and phone only with include_pii. */
export function mcpContactRow(r: ContactRow, includePii: boolean): Record<string, unknown> {
    const row: Record<string, unknown> = {
        public_id: r.public_id,
        lifecycle: r.lifecycle,
        country: r.customer_country ?? null,
        email_status: r.email_status ?? null,
        sms_status: r.sms_status ?? null,
        tags: r.tags ?? [],
        total_orders: r.total_orders ?? 0,
        lifetime_value: r.lifetime_value ?? 0,
        last_order_date: r.last_order_date ?? null,
    };
    if (includePii) {
        row.name = r.customer_name ?? null;
        row.email = r.customer_email ?? null;
        row.phone = r.customer_phone ?? null;
    }
    return row;
}

function oneOf<T extends string>(flag: string, raw: string | undefined, allowed: readonly T[]): T | undefined {
    if (raw == null) return undefined;
    const v = raw.toLowerCase() as T;
    if (!allowed.includes(v)) throw new CliError(ExitCode.Validation, `--${flag} must be one of ${allowed.join(', ')}. Got "${raw}".`);
    return v;
}

interface ListFlags {
    lifecycle?: string; q?: string; phone?: string; tag?: string; emailStatus?: string; smsStatus?: string; sort?: string;
    limit?: string; all?: boolean; includePii?: boolean; json?: boolean;
}

export function listParams(opts: ListFlags): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const lifecycle = oneOf('lifecycle', opts.lifecycle, LIFECYCLES);
    if (lifecycle) params.lifecycle = lifecycle;
    if (opts.q && opts.q.trim()) params.q = opts.q.trim();
    const phone = (opts.phone ?? '').replace(/\D+/g, '');
    if (phone) params.phone = phone;
    if (opts.tag) params.tag = opts.tag;
    const es = oneOf('email-status', opts.emailStatus, EMAIL_STATUSES);
    if (es) params.email_status = es;
    const ss = oneOf('sms-status', opts.smsStatus, SMS_STATUSES);
    if (ss) params.sms_status = ss;
    const sort = oneOf('sort', opts.sort, SORTS);
    if (sort) params.sort = sort;
    return params;
}

async function fetchContacts(api: ApiClient, brandId: number, params: Record<string, unknown>, limit: number | null) {
    const rows: ContactRow[] = [];
    let total = 0;
    let canViewPii = false;
    for (let page = 1; ; page++) {
        const perPage = limit == null ? PER_PAGE : Math.min(PER_PAGE, limit - rows.length);
        const res = await api.listContacts(brandId, { ...params, per_page: perPage, page });
        total = res.total;
        canViewPii = res.can_view_pii;
        rows.push(...res.data);
        if (res.data.length === 0 || page >= res.last_page) break;
        if (limit != null && rows.length >= limit) break;
    }
    return { rows: limit == null ? rows : rows.slice(0, limit), total, canViewPii };
}

function money(n: unknown): string {
    return typeof n === 'number' ? n.toFixed(2) : '-';
}

async function runList(opts: ListFlags): Promise<void> {
    if (opts.includePii && !opts.json) {
        throw new CliError(ExitCode.Validation, '--include-pii only applies to --json. The table never prints personal data.');
    }
    const params = listParams(opts);
    const limit = opts.all ? null : positiveInt('limit', opts.limit, 50);
    const rt = await loadRuntime();
    const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
    const { rows, total, canViewPii } = await fetchContacts(api, rt.config.brandId, params, limit);

    if (opts.json) {
        log.json({
            ok: true,
            brand_id: rt.config.brandId,
            total,
            count: rows.length,
            pii: !!opts.includePii,
            can_view_pii: canViewPii,
            contacts: opts.includePii ? rows : rows.map(r => stripListPii(r as unknown as Record<string, unknown>)),
        });
        return;
    }

    if (rows.length === 0) { log.info('No contacts match.'); return; }
    const table = rows.map(r => [
        r.public_id,
        String(r.lifecycle ?? ''),
        String(r.customer_country ?? '-'),
        String(r.email_status ?? '-'),
        String(r.sms_status ?? '-'),
        String(r.total_orders ?? 0),
        money(r.lifetime_value),
        (r.tags ?? []).join(', ') || '-',
        String(r.created_at ?? '-').slice(0, 10),
    ]);
    process.stdout.write(renderTable({ head: ['PUBLIC ID', 'LIFECYCLE', 'COUNTRY', 'EMAIL', 'SMS', 'ORDERS', 'LTV', 'TAGS', 'CREATED'], rows: table, maxCellWidth: 40 }) + '\n');
    log.detail(`${rows.length} of ${total} contact(s)${rows.length < total ? '; raise --limit or pass --all for more' : ''}. Personal data is never printed here; use --json --include-pii.`);
}

function withListFlags(cmd: Command): Command {
    return cmd
        .option('--lifecycle <kind>', `Only ${LIFECYCLES.join(' | ')}. Default: all.`)
        .option('--phone <digits>', 'Only contacts with a phone number containing these digits.')
        .option('--tag <tag>', 'Only contacts with this tag.')
        .option('--email-status <status>', `Only this email status: ${EMAIL_STATUSES.join(' | ')}.`)
        .option('--sms-status <status>', `Only this SMS status: ${SMS_STATUSES.join(' | ')}.`)
        .option('--sort <order>', `${SORTS.join(' | ')}. Default: newest.`)
        .option('--limit <n>', 'Max contacts to fetch.', '50')
        .option('--all', 'Fetch every match (pages through 100 at a time).')
        .option('--include-pii', 'With --json: keep emails, phones, names and postal codes (masked by the server unless you hold contacts.view_pii).')
        .option('--json', 'Print as JSON (personal data dropped unless --include-pii).');
}

export function registerContactsCommand(program: Command): void {
    const cmd = program
        .command('contacts')
        .description('Contacts for this brand (leads and buyers, read-only): list, search, get one.');

    withListFlags(
        cmd.command('list')
            .alias('ls')
            .description('List contacts with lifecycle, consent status, orders and lifetime value.')
            .option('--q <text>', 'Match first name, last name or email.'),
    )
        .addHelpText('after', `
Examples:
  $ ef contacts list --lifecycle lead --limit 20
  $ ef contacts list --email-status subscribed --all --json
  $ ef contacts get 01JCT360AAAAAAAAAAAAAAAAAA

Needs the customers.view permission. Emails, phones and names come back
masked unless your user holds contacts.view_pii.`)
        .action(async (opts: ListFlags) => runList(opts));

    withListFlags(
        cmd.command('search <query>')
            .description('Find contacts by name or email (same filters as list; --phone for phone numbers).'),
    )
        .action(async (query: string, opts: ListFlags) => {
            if (!query || !query.trim()) throw new CliError(ExitCode.Validation, 'Give something to search for: a name or an email.');
            await runList({ ...opts, q: query });
        });

    cmd.command('get <public_id>')
        .description('One contact: lifecycle, consent, order totals, tags, merges.')
        .option('--include-pii', 'With --json: keep emails, phones, names, consent addresses and merges (masked by the server unless you hold contacts.view_pii).')
        .option('--json', 'Print as JSON (personal data dropped unless --include-pii).')
        .action(async (publicId: string, opts: { includePii?: boolean; json?: boolean }) => {
            if (!PUBLIC_ID.test(publicId)) throw new CliError(ExitCode.Validation, `A contact public id is 26 letters and digits. Got "${publicId}".`);
            if (opts.includePii && !opts.json) {
                throw new CliError(ExitCode.Validation, '--include-pii only applies to --json. The summary never prints personal data.');
            }
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const { contact, redirect_public_id } = await api.getContact(rt.config.brandId, publicId);

            if (opts.json) {
                log.json({
                    ok: true,
                    brand_id: rt.config.brandId,
                    pii: !!opts.includePii,
                    ...(redirect_public_id ? { redirect_public_id } : {}),
                    contact: opts.includePii ? contact : stripDetailPii(contact),
                });
                return;
            }

            if (redirect_public_id) log.info(`${publicId} was merged into ${redirect_public_id}; showing that contact.`);
            const lines: [string, string][] = [
                ['Public id', contact.public_id],
                ['Lifecycle', String(contact.lifecycle ?? '-')],
                ['Country', String(contact.country ?? '-')],
                ['Email status', String(contact.email_status ?? '-')],
                ['SMS status', String(contact.sms_status ?? '-')],
                ['Orders', String(contact.orders_count ?? 0)],
                ['Purchases', `${money(contact.purchases_total)}${contact.currency_code ? ` ${contact.currency_code}` : ''}`],
                ['Tags', (contact.tags ?? []).join(', ') || '-'],
                ['Emails / phones', `${contact.emails?.length ?? 0} / ${contact.phones?.length ?? 0}`],
                ['Merges', String(contact.merges?.length ?? 0)],
            ];
            process.stdout.write(renderTable({ head: ['FIELD', 'VALUE'], rows: lines, maxCellWidth: 60 }) + '\n');
            log.detail('Personal data is never printed here; use --json --include-pii.');
        });
}
