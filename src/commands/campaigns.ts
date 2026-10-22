import { Command } from 'commander';
import * as fs from 'fs/promises';
import { ApiClient } from '../api/client';
import { emailCampaigns, smsCampaigns } from '../api/campaignsApi';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatRelative, renderTable } from '../utils/format';
import { numericId, printRows } from './audiences';

// `ef campaigns email|sms`: build a campaign, check its audience, send a test, then schedule or launch.
// Launch and schedule always print the audience size first and need --yes (or a typed confirmation in a
// terminal). Tests never ask. Consent, suppressions and quiet hours are enforced by the server; the
// ef-campaigns skill explains them.

async function ctx(): Promise<{ api: ApiClient; brandId: number }> {
    const rt = await loadRuntime();
    return { api: new ApiClient(rt.config.apiUrl, rt.apiKey), brandId: rt.config.brandId };
}

async function readText(path: string): Promise<string> {
    try { return await fs.readFile(path, 'utf8'); } catch (err) {
        throw new CliError(ExitCode.NotFound, `Cannot read ${path}: ${(err as Error).message}`);
    }
}

/** Launch / schedule / cancel gate: --yes, or a typed "y" in a terminal. Never proceeds silently. */
async function confirmSend(yes: boolean | undefined, prompt: string): Promise<void> {
    if (yes) return;
    if (!process.stdin.isTTY) throw new CliError(ExitCode.Validation, `${prompt} Re-run with --yes to confirm (no terminal to ask on).`);
    const { confirm } = await import('../utils/prompt');
    if (!(await confirm(prompt, false))) throw new CliError(ExitCode.Validation, 'Aborted, nothing was sent.');
}

function isoAt(at: string): string {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) throw new CliError(ExitCode.Validation, `--at must be a date/time, e.g. 2026-11-01T15:00:00Z (got "${at}").`);
    if (d.getTime() <= Date.now() + 60_000) throw new CliError(ExitCode.Validation, '--at must be more than a minute in the future.');
    return d.toISOString();
}

function ids(csv: string | undefined): number[] | undefined {
    if (csv == null) return undefined;
    return csv.split(',').map((s) => s.trim()).filter(Boolean).map((s) => numericId(s, 'audience'));
}

function n(v: unknown): string { return v == null ? '' : String(v); }

// ═══ Email ════════════════════════════════════════════════════════════════

interface EmailFieldOpts {
    name?: string; subject?: string; previewText?: string; fromName?: string; fromEmail?: string; replyTo?: string;
    sender?: string; integration?: string;
    audience?: string; allCustomers?: boolean; emails?: string; emailsFile?: string; crmEntity?: string;
    htmlFile?: string; cssFile?: string;
}

function emailFieldOptions(cmd: Command): Command {
    return cmd
        .option('--name <name>', 'Internal campaign name.')
        .option('--subject <text>', 'Subject line.')
        .option('--preview-text <text>', 'Inbox preview text.')
        .option('--from-name <name>', 'From name.')
        .option('--from-email <email>', 'From address (must be on a verified sending domain).')
        .option('--reply-to <email>', 'Reply-to address.')
        .option('--sender <kind>', 'integration | brand_smtp.')
        .option('--integration <id>', 'Sending integration id (for --sender integration).')
        .option('--audience <id>', 'Send to a saved audience (segment id).')
        .option('--all-customers', 'Send to every customer with an email.')
        .option('--emails <list>', 'Send to a manual list: comma-separated addresses.')
        .option('--emails-file <path>', 'Send to a manual list: one address per line.')
        .option('--crm-entity <id>', 'Send to the records of a CRM collection.')
        .option('--html-file <path>', 'Email body HTML (replaces the content).')
        .option('--css-file <path>', 'CSS to go with --html-file.');
}

async function emailAudience(opts: EmailFieldOpts): Promise<Record<string, unknown> | undefined> {
    const picked = [opts.audience, opts.allCustomers, opts.emails, opts.emailsFile, opts.crmEntity].filter((v) => v != null && v !== false);
    if (picked.length > 1) throw new CliError(ExitCode.Validation, 'Pick one audience: --audience, --all-customers, --emails, --emails-file or --crm-entity.');
    if (opts.audience != null) return { audience_type: 'analytics_segment', audience_config: { segment_id: numericId(opts.audience) } };
    if (opts.allCustomers) return { audience_type: 'all_customers', audience_config: null };
    if (opts.crmEntity != null) return { audience_type: 'crm_collection', audience_config: { crm_entity_id: numericId(opts.crmEntity, 'CRM entity') } };
    if (opts.emails != null || opts.emailsFile != null) {
        const raw = opts.emails ?? await readText(opts.emailsFile!);
        const list = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        if (!list.length) throw new CliError(ExitCode.Validation, 'The manual list is empty.');
        return { audience_type: 'manual_list', audience_config: { emails: list } };
    }
    return undefined;
}

async function emailFields(opts: EmailFieldOpts): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};
    if (opts.name != null) data.name = opts.name;
    if (opts.subject != null) data.subject = opts.subject;
    if (opts.previewText != null) data.preview_text = opts.previewText;
    if (opts.fromName != null) data.from_name = opts.fromName;
    if (opts.fromEmail != null) data.from_email = opts.fromEmail;
    if (opts.replyTo != null) data.reply_to_email = opts.replyTo;
    if (opts.sender != null) data.sender = opts.sender;
    if (opts.integration != null) data.integration_id = numericId(opts.integration, 'integration');
    Object.assign(data, (await emailAudience(opts)) ?? {});
    return data;
}

async function saveHtml(api: ApiClient, brandId: number, campaign: any, opts: EmailFieldOpts): Promise<boolean> {
    if (opts.htmlFile == null) {
        if (opts.cssFile != null) throw new CliError(ExitCode.Validation, '--css-file needs --html-file.');
        return false;
    }
    if (!campaign.email_id) throw new CliError(ExitCode.Server, `Campaign #${campaign.id} has no email body to write to.`);
    const html = await readText(opts.htmlFile);
    const css = opts.cssFile != null ? await readText(opts.cssFile) : '';
    await api.saveEmailBody(brandId, campaign.email_id, { html, css });
    return true;
}

async function emailAudienceSize(api: ApiClient, brandId: number, c: any): Promise<any> {
    return emailCampaigns.previewAudience(api, brandId, { audience_type: c.audience_type, audience_config: c.audience_config ?? {} });
}

function describeEmailAudience(p: any): string {
    const ex = p?.excluded ?? {};
    const est = p?.exact === false ? '; estimate' : '';
    return `${p?.count ?? p?.eligible ?? '?'} will receive it (of ${n(p?.total)}; excluded: ${ex.suppressed ?? 0} suppressed, `
        + `${ex.no_consent ?? 0} without consent, ${ex.duplicates ?? 0} duplicates${est})`;
}

function registerEmail(parent: Command): void {
    const em = parent.command('email').description('Email campaigns (broadcasts).');

    em.command('list', { isDefault: true }).alias('ls')
        .description('List email campaigns.')
        .option('--status <status>', 'draft | queued | sending | sent | failed | canceled.')
        .option('--q <text>', 'Search by name or subject.')
        .option('--json', 'Print the response as JSON.')
        .action(async (opts: { status?: string; q?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const params: Record<string, unknown> = { per_page: 100 };
            if (opts.status) params.status = opts.status;
            if (opts.q) params.q = opts.q;
            const res: any = await emailCampaigns.list(api, brandId, params);
            if (opts.json) { log.json(res); return; }
            const rows = res?.data ?? [];
            log.raw(renderTable({
                head: ['#', 'name', 'status', 'audience', 'sent', 'open %', 'click %', 'updated'],
                rows: rows.map((c: any) => [String(c.id), n(c.name), n(c.status), n(c.audience_type), n(c.sent_count), n(c.open_rate), n(c.click_rate), c.updated_at ? formatRelative(c.updated_at) : '']),
            }) + '\n');
            log.detail(`${res?.total ?? rows.length} campaigns`);
        });

    em.command('get <id>').description('Print one email campaign as JSON (includes readiness problems).')
        .action(async (id: string) => {
            const { api, brandId } = await ctx();
            log.json(await emailCampaigns.get(api, brandId, numericId(id, 'campaign')));
        });

    emailFieldOptions(em.command('create'))
        .description('Create a draft email campaign.')
        .option('--content <source>', 'Starting content: default | blank | template | campaign.', 'default')
        .option('--content-id <id>', 'Template or campaign id for --content template|campaign.')
        .option('--json', 'Print the campaign as JSON.')
        .action(async (opts: EmailFieldOpts & { content: string; contentId?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const data = await emailFields(opts);
            data.content_source = opts.content;
            if (opts.contentId != null) data.content_source_id = numericId(opts.contentId, 'content source');
            const res: any = await emailCampaigns.create(api, brandId, data);
            let campaign = res.campaign ?? res;
            if (await saveHtml(api, brandId, campaign, opts)) campaign = await emailCampaigns.get(api, brandId, campaign.id);
            if (opts.json) { log.json(campaign); return; }
            log.success(`Created draft email campaign #${campaign.id}.`);
            printProblems(campaign.problems);
        });

    const setCmd = (name: string, desc: string) => emailFieldOptions(em.command(`${name} <id>`))
        .description(desc)
        .option('--content <source>', 'Reset content from: default | blank | template | campaign.')
        .option('--content-id <id>', 'Template or campaign id for --content.')
        .option('--json', 'Print the campaign as JSON.')
        .action(async (id: string, opts: EmailFieldOpts & { content?: string; contentId?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const cid = numericId(id, 'campaign');
            const data = await emailFields(opts);
            let campaign: any = Object.keys(data).length ? (await emailCampaigns.update(api, brandId, cid, data)) : null;
            if (opts.content != null) {
                const body: Record<string, unknown> = { source: opts.content };
                if (opts.contentId != null) body.source_id = numericId(opts.contentId, 'content source');
                await emailCampaigns.setContent(api, brandId, cid, body);
            }
            campaign = await emailCampaigns.get(api, brandId, cid);
            const wroteHtml = await saveHtml(api, brandId, campaign, opts);
            if (!Object.keys(data).length && opts.content == null && !wroteHtml) {
                throw new CliError(ExitCode.Validation, 'Nothing to change: pass a field such as --subject, --audience or --html-file.');
            }
            if (wroteHtml) campaign = await emailCampaigns.get(api, brandId, cid);
            if (opts.json) { log.json(campaign); return; }
            log.success(`Updated email campaign #${cid}.`);
            printProblems(campaign.problems);
        });
    setCmd('set', 'Change subject, sender, audience or content of a draft.');
    setCmd('audience', 'Set who receives a draft (--audience <segment id>, --all-customers, --emails, --crm-entity).');

    em.command('audience-preview <id>').alias('count')
        .description('How many people the campaign would reach now, after suppressions and consent (sample masked without contacts.view_pii).')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const c: any = await emailCampaigns.get(api, brandId, numericId(id, 'campaign'));
            const p = await emailAudienceSize(api, brandId, c);
            if (opts.json) { log.json(p); return; }
            log.success(describeEmailAudience(p));
            printRows(p?.sample ?? []);
        });

    em.command('test <id>')
        .description('Send one test email (defaults to your own address). Does not touch the audience.')
        .option('--to <email>', 'Recipient of the test.')
        .option('--variant <id>', 'Send a split-test variant instead of the main version.')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { to?: string; variant?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const data: Record<string, unknown> = {};
            if (opts.to) data.to = opts.to;
            if (opts.variant) data.variant_id = numericId(opts.variant, 'variant');
            const res: any = await emailCampaigns.sendTest(api, brandId, numericId(id, 'campaign'), data);
            if (opts.json) { log.json(res); return; }
            if (res?.success === false) throw new CliError(ExitCode.Error, `Test email failed: ${res.error ?? res.error_code ?? 'unknown error'}`);
            log.success(`Test sent to ${res?.to ?? opts.to ?? 'you'}${res?.provider ? ` via ${res.provider}` : ''}.`);
        });

    const launchCmd = (name: 'launch' | 'schedule') => {
        const cmd = em.command(`${name} <id>`)
            .description(name === 'launch' ? 'Send the campaign now to its audience. Prints the audience size and needs --yes.' : 'Schedule the campaign. Prints the audience size and needs --yes.');
        if (name === 'schedule') cmd.requiredOption('--at <datetime>', 'When to send (ISO 8601, e.g. 2026-11-01T15:00:00Z).');
        cmd.option('-y, --yes', 'Confirm the send without a prompt.')
            .option('--skip-test', 'Launch even though no test email was sent.')
            .option('--json', 'Print the response as JSON.')
            .action(async (id: string, opts: { at?: string; yes?: boolean; skipTest?: boolean; json?: boolean }) => {
                const { api, brandId } = await ctx();
                const cid = numericId(id, 'campaign');
                const at = opts.at != null ? isoAt(opts.at) : undefined;
                const c: any = await emailCampaigns.get(api, brandId, cid);
                if (Array.isArray(c.problems) && c.problems.length) {
                    printProblems(c.problems);
                    throw new CliError(ExitCode.Validation, `Campaign #${cid} is not ready to send.`);
                }
                const p = await emailAudienceSize(api, brandId, c);
                log.info(`Campaign #${cid} "${c.name ?? c.subject ?? ''}": ${describeEmailAudience(p)}.`);
                await confirmSend(opts.yes, at ? `Schedule it for ${at} to ${p?.count ?? '?'} people?` : `Send it now to ${p?.count ?? '?'} people?`);
                const data: Record<string, unknown> = {};
                if (at) data.schedule_at = at;
                if (opts.skipTest) data.confirm_without_test = true;
                const res: any = await emailCampaigns.launch(api, brandId, cid, data);
                if (opts.json) { log.json({ ...res, audience: { count: p?.count ?? null } }); return; }
                log.success(res?.scheduled ? `Scheduled #${cid} for ${res.schedule_at}.` : `Launched #${cid}; sending has started.`);
            });
    };
    launchCmd('launch');
    launchCmd('schedule');

    em.command('unschedule <id>').description('Move a scheduled campaign back to draft.')
        .action(async (id: string) => {
            const { api, brandId } = await ctx();
            await emailCampaigns.unschedule(api, brandId, numericId(id, 'campaign'));
            log.success(`Campaign #${id} is a draft again.`);
        });

    em.command('cancel <id>').description('Stop a scheduled or sending campaign.')
        .option('-y, --yes', 'Do not ask for confirmation.')
        .action(async (id: string, opts: { yes?: boolean }) => {
            const { api, brandId } = await ctx();
            await confirmSend(opts.yes, `Cancel campaign #${id}?`);
            await emailCampaigns.cancel(api, brandId, numericId(id, 'campaign'));
            log.success(`Campaign #${id} canceled.`);
        });

    em.command('stats <id>').alias('report')
        .description('Delivery, opens, clicks, bounces and unsubscribes.')
        .option('--json', 'Print the campaign counts and full report as JSON.')
        .action(async (id: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const cid = numericId(id, 'campaign');
            const [c, report]: any[] = await Promise.all([emailCampaigns.get(api, brandId, cid), emailCampaigns.report(api, brandId, cid)]);
            if (opts.json) { log.json({ campaign: c, report }); return; }
            log.info(`#${cid} ${n(c.name)} [${n(c.status)}]`);
            log.raw(renderTable({
                head: ['recipients', 'sent', 'delivered', 'failed', 'bounced', 'opened', 'clicked', 'unsub', 'complaints'],
                rows: [[n(c.recipients_total), n(c.sent_count), n(c.delivered_count), n(c.failed_count), n(c.bounced_count),
                    `${n(c.opened_count)}${c.open_rate != null ? ` (${c.open_rate}%)` : ''}`, `${n(c.clicked_count)}${c.click_rate != null ? ` (${c.click_rate}%)` : ''}`,
                    n(c.unsubscribed_count), n(c.complained_count)]],
            }) + '\n');
        });

    em.command('recipients <id>').description('Who it went to and what happened (masked without contacts.view_pii).')
        .option('--page <n>', 'Page.', '1')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { page: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const res: any = await emailCampaigns.recipients(api, brandId, numericId(id, 'campaign'), { page: parseInt(opts.page, 10) || 1 });
            if (opts.json) { log.json(res); return; }
            printRows(res?.data ?? []);
            log.detail(`${res?.total ?? 0} recipients`);
        });

    em.command('delete <id>').alias('rm').description('Delete a draft campaign.')
        .option('-y, --yes', 'Do not ask for confirmation.')
        .action(async (id: string, opts: { yes?: boolean }) => {
            const { api, brandId } = await ctx();
            await confirmSend(opts.yes, `Delete campaign #${id}?`);
            await emailCampaigns.remove(api, brandId, numericId(id, 'campaign'));
            log.success(`Deleted campaign #${id}.`);
        });
}

function printProblems(problems: unknown): void {
    if (!Array.isArray(problems) || !problems.length) return;
    log.warn(`Not ready to send yet: ${problems.map((p: any) => (typeof p === 'string' ? p : p?.code ?? p?.message ?? JSON.stringify(p))).join(', ')}`);
}

// ═══ SMS ══════════════════════════════════════════════════════════════════

interface SmsFieldOpts {
    name?: string; body?: string; bodyFile?: string; footer?: string; optOut?: string;
    audience?: string; exclude?: string; sender?: string; excludeRegions?: string;
}

function smsFieldOptions(cmd: Command): Command {
    return cmd
        .option('--name <name>', 'Internal campaign name.')
        .option('--body <text>', 'Message text (up to 1600 characters; {first_name|there} for the first name with a fallback).')
        .option('--body-file <path>', 'Read the message text from a file.')
        .option('--footer <text>', 'Opt-out footer; must contain STOP (default "Reply STOP to opt out").')
        .option('--opt-out <yes|no>', 'Append the opt-out footer (keep yes for marketing texts).')
        .option('--audience <ids>', 'Audience (segment) ids to send to, comma-separated.')
        .option('--exclude <ids>', 'Audience ids to leave out, comma-separated.')
        .option('--sender <id>', 'Sender (number) id.')
        .option('--exclude-regions <codes>', 'Regions to skip, e.g. US-FL,US-OK.');
}

async function smsFields(opts: SmsFieldOpts, current?: any): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};
    if (opts.body != null && opts.bodyFile != null) throw new CliError(ExitCode.Validation, 'Pass either --body or --body-file.');
    if (opts.name != null) data.name = opts.name;
    if (opts.body != null) data.body = opts.body;
    if (opts.bodyFile != null) data.body = (await readText(opts.bodyFile)).trim();
    if (opts.footer != null) data.footer = opts.footer;
    if (opts.optOut != null) {
        if (!/^(yes|no|true|false|on|off)$/i.test(opts.optOut)) throw new CliError(ExitCode.Validation, '--opt-out takes yes or no.');
        data.include_opt_out = /^(yes|true|on)$/i.test(opts.optOut);
    }
    if (opts.audience != null || opts.exclude != null) {
        const cur = current?.audience ?? {};
        data.audience = {
            segment_ids: ids(opts.audience) ?? cur.segment_ids ?? [],
            exclude_segment_ids: ids(opts.exclude) ?? cur.exclude_segment_ids ?? [],
        };
    }
    if (opts.sender != null) data.sender_id = numericId(opts.sender, 'sender');
    if (opts.excludeRegions != null) data.exclude_regions = opts.excludeRegions.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    return data;
}

function describeSmsAudience(p: any): string {
    const s = p?.skips ?? {};
    const skipped = Object.entries(s).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`);
    const warn = p?.consent_warning_count ? `; ${p.consent_warning_count} have no recorded consent (warned, not skipped)` : '';
    return `${p?.reachable ?? '?'} reachable of ${n(p?.total)}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}${warn}`;
}

async function smsAudienceSize(api: ApiClient, brandId: number, c: any): Promise<any> {
    return smsCampaigns.previewAudience(api, brandId, { audience: c.audience ?? {}, exclude_regions: c.exclude_regions ?? [] });
}

function registerSms(parent: Command): void {
    const sm = parent.command('sms').description('SMS campaigns.');

    sm.command('list', { isDefault: true }).alias('ls')
        .description('List SMS campaigns.')
        .option('--status <status>', 'draft | scheduled | sending | paused | canceled.')
        .option('--json', 'Print the response as JSON.')
        .action(async (opts: { status?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const params: Record<string, unknown> = { per_page: 100 };
            if (opts.status) params.status = opts.status;
            const res: any = await smsCampaigns.list(api, brandId, params);
            if (opts.json) { log.json(res); return; }
            const rows = res?.data ?? [];
            log.raw(renderTable({
                head: ['#', 'name', 'status', 'recipients', 'sent', 'delivered', 'failed', 'text'],
                rows: rows.map((c: any) => [String(c.id), n(c.name), n(c.status), n(c.recipients_count), n(c.sent_count), n(c.delivered_count), n(c.failed_count), n(c.body_preview).slice(0, 40)]),
            }) + '\n');
            log.detail(`${res?.total ?? rows.length} campaigns`);
        });

    sm.command('get <id>').description('Print one SMS campaign as JSON.')
        .action(async (id: string) => {
            const { api, brandId } = await ctx();
            log.json(await smsCampaigns.get(api, brandId, numericId(id, 'campaign')));
        });

    smsFieldOptions(sm.command('create'))
        .description('Create a draft SMS campaign.')
        .option('--json', 'Print the campaign as JSON.')
        .action(async (opts: SmsFieldOpts & { json?: boolean }) => {
            const { api, brandId } = await ctx();
            if (!opts.name) throw new CliError(ExitCode.Validation, '--name is required.');
            const fields = await smsFields(opts);
            const created: any = await smsCampaigns.create(api, brandId, { name: opts.name, include_opt_out: fields.include_opt_out ?? true });
            delete fields.name; delete fields.include_opt_out;
            const c: any = Object.keys(fields).length ? await smsCampaigns.update(api, brandId, created.id, fields) : created;
            if (opts.json) { log.json(c); return; }
            log.success(`Created draft SMS campaign #${c.id}.`);
        });

    const setCmd = (name: string, desc: string) => smsFieldOptions(sm.command(`${name} <id>`))
        .description(desc)
        .option('--json', 'Print the campaign as JSON.')
        .action(async (id: string, opts: SmsFieldOpts & { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const cid = numericId(id, 'campaign');
            const current = (opts.audience != null) !== (opts.exclude != null) ? await smsCampaigns.get(api, brandId, cid) : undefined;
            const data = await smsFields(opts, current);
            if (!Object.keys(data).length) throw new CliError(ExitCode.Validation, 'Nothing to change: pass a field such as --body or --audience.');
            const c: any = await smsCampaigns.update(api, brandId, cid, data);
            if (opts.json) { log.json(c); return; }
            log.success(`Updated SMS campaign #${cid}.`);
        });
    setCmd('set', 'Change the text, footer, sender or audience of a draft.');
    setCmd('audience', 'Set who receives a draft (--audience <ids>, --exclude <ids>, --exclude-regions).');

    sm.command('audience-preview <id>').alias('count')
        .description('How many phones the campaign would reach now (counts only, no numbers).')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const c: any = await smsCampaigns.get(api, brandId, numericId(id, 'campaign'));
            const p = await smsAudienceSize(api, brandId, c);
            if (opts.json) { log.json(p); return; }
            log.success(describeSmsAudience(p));
        });

    sm.command('preview <id>')
        .description('Render the text as it will go out: characters, segments, encoding, compliance warnings. Sends nothing.')
        .option('--body <text>', 'Preview this text instead of the saved one.')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { body?: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const res: any = await smsCampaigns.preview(api, brandId, numericId(id, 'campaign'), opts.body != null ? { body: opts.body } : {});
            if (opts.json) { log.json(res); return; }
            log.raw(`${n(res?.rendered)}\n`);
            log.detail(`${n(res?.chars)} chars, ${n(res?.segments)} segment(s), ${n(res?.encoding)}`);
            for (const w of [...(res?.blocks ?? []), ...(res?.warnings ?? [])]) log.warn(typeof w === 'string' ? w : (w?.message ?? w?.code ?? JSON.stringify(w)));
        });

    sm.command('test <id>')
        .description('Send one test text to a phone you own. Goes through the real provider and compliance checks.')
        .requiredOption('--phone <e164>', 'Recipient, e.g. +14155550123.')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { phone: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const res: any = await smsCampaigns.sendTest(api, brandId, numericId(id, 'campaign'), opts.phone);
            if (opts.json) { log.json(res); return; }
            if (res?.skip_reason) log.warn(`Test not sent: ${res.skip_reason}`);
            else log.success(`Test message #${res?.message_id} ${res?.status ?? 'queued'}.`);
            for (const w of res?.warnings ?? []) log.warn(typeof w === 'string' ? w : (w?.message ?? w?.code ?? JSON.stringify(w)));
        });

    const launchCmd = (name: 'launch' | 'schedule') => {
        const cmd = sm.command(`${name} <id>`)
            .description(name === 'launch' ? 'Start sending now (quiet hours still defer texts). Prints the audience size and needs --yes.' : 'Schedule the campaign. Prints the audience size and needs --yes.');
        if (name === 'schedule') cmd.requiredOption('--at <datetime>', 'When to start (ISO 8601).');
        cmd.option('-y, --yes', 'Confirm the send without a prompt.')
            .option('--json', 'Print the response as JSON.')
            .action(async (id: string, opts: { at?: string; yes?: boolean; json?: boolean }) => {
                const { api, brandId } = await ctx();
                const cid = numericId(id, 'campaign');
                const at = opts.at != null ? isoAt(opts.at) : undefined;
                const c: any = await smsCampaigns.get(api, brandId, cid);
                const p = await smsAudienceSize(api, brandId, c);
                log.info(`SMS campaign #${cid} "${n(c.name)}": ${describeSmsAudience(p)}.`);
                await confirmSend(opts.yes, at ? `Schedule it for ${at} to ${p?.reachable ?? '?'} phones?` : `Start sending now to ${p?.reachable ?? '?'} phones?`);
                const res: any = await smsCampaigns.launch(api, brandId, cid, at ? { schedule_at: at } : {});
                if (opts.json) { log.json({ ...res, audience: { reachable: p?.reachable ?? null } }); return; }
                log.success(`SMS campaign #${cid} is ${res?.status}${res?.schedule_at ? ` for ${res.schedule_at}` : ''}.`);
            });
    };
    launchCmd('launch');
    launchCmd('schedule');

    for (const action of ['unschedule', 'pause', 'resume', 'cancel'] as const) {
        const cmd = sm.command(`${action} <id>`).description({
            unschedule: 'Move a scheduled campaign back to draft.',
            pause: 'Pause a sending campaign.',
            resume: 'Resume a paused campaign.',
            cancel: 'Stop a campaign for good.',
        }[action]);
        if (action === 'resume' || action === 'cancel') cmd.option('-y, --yes', 'Do not ask for confirmation.');
        cmd.action(async (id: string, opts: { yes?: boolean }) => {
            const { api, brandId } = await ctx();
            if (action === 'resume' || action === 'cancel') await confirmSend(opts.yes, `${action === 'resume' ? 'Resume sending' : 'Cancel'} SMS campaign #${id}?`);
            const c: any = await smsCampaigns.transition(api, brandId, numericId(id, 'campaign'), action);
            log.success(`SMS campaign #${id} is ${c?.status ?? action}.`);
        });
    }

    sm.command('stats <id>').alias('report')
        .description('Sent, delivered, failed, skipped (by reason), clicks and opt-outs.')
        .option('--json', 'Print the report as JSON.')
        .action(async (id: string, opts: { json?: boolean }) => {
            const { api, brandId } = await ctx();
            const cid = numericId(id, 'campaign');
            const report: any = await smsCampaigns.report(api, brandId, cid);
            if (opts.json) { log.json(report); return; }
            const c: any = await smsCampaigns.get(api, brandId, cid);
            log.info(`#${cid} ${n(c.name)} [${n(c.status)}]`);
            log.raw(renderTable({
                head: ['recipients', 'sent', 'delivered', 'failed'],
                rows: [[n(c.recipients_count), n(c.sent_count), n(c.delivered_count), n(c.failed_count)]],
            }) + '\n');
            const skipped = Object.entries(c.skipped_counts ?? {}).map(([k, v]) => `${k}: ${v}`);
            if (skipped.length) log.detail(`skipped: ${skipped.join(', ')}`);
        });

    sm.command('recipients <id>').description('Recipients and their status (numbers masked).')
        .option('--page <n>', 'Page.', '1')
        .option('--json', 'Print the response as JSON.')
        .action(async (id: string, opts: { page: string; json?: boolean }) => {
            const { api, brandId } = await ctx();
            const res: any = await smsCampaigns.recipients(api, brandId, numericId(id, 'campaign'), { page: parseInt(opts.page, 10) || 1 });
            if (opts.json) { log.json(res); return; }
            printRows(res?.data ?? []);
            log.detail(`${res?.total ?? 0} recipients`);
        });

    sm.command('delete <id>').alias('rm').description('Delete a draft SMS campaign.')
        .option('-y, --yes', 'Do not ask for confirmation.')
        .action(async (id: string, opts: { yes?: boolean }) => {
            const { api, brandId } = await ctx();
            await confirmSend(opts.yes, `Delete SMS campaign #${id}?`);
            await smsCampaigns.remove(api, brandId, numericId(id, 'campaign'));
            log.success(`Deleted SMS campaign #${id}.`);
        });
}

export function registerCampaignsCommand(program: Command): void {
    const camp = program.command('campaigns')
        .description('Email and SMS campaigns: create, set audience and content, test, schedule, launch, stats.');
    registerEmail(camp);
    registerSms(camp);
}
