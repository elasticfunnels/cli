import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { BrandDomain, DomainValidationInstructions } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatRelative, renderTable } from '../utils/format';

/**
 * `ef domains` — manage a brand's custom domains.
 *
 * Add a dedicated (customer-owned) domain, print the exact DNS records the
 * owner must create (a TXT ownership record + a CNAME to the platform domain),
 * and trigger validation. Mirrors the dashboard's Domains → Add + Validate flow
 * so a domain added by the CLI behaves identically to one added in the app.
 */

export function statusLabel(status?: string): string {
    switch (status) {
        case 'validated': return 'LIVE';
        case 'pending-cloudflare': return 'pending DNS records';
        case 'pending':
        case 'pending-validation': return 'pending validation';
        case 'validation-failed': return 'validation failed';
        case 'giveup-validation': return 'gave up — recheck records';
        default: return status ?? 'unknown';
    }
}

/** Resolve a domain by numeric id or by (case-insensitive) domain name. */
export async function resolveDomain(api: ApiClient, brandId: number, ref: string): Promise<BrandDomain> {
    const id = parseInt(ref, 10);
    if (Number.isFinite(id) && /^\d+$/.test(ref)) {
        return api.getDomain(brandId, id);
    }
    const needle = ref.trim().toLowerCase();
    const all = await api.listDomains(brandId);
    const found = all.find((d) => (d.domain ?? '').toLowerCase() === needle);
    if (!found) throw new CliError(ExitCode.NotFound, `No domain "${ref}" in this brand. Run "ef domains list".`);
    return found;
}

/** Render the DNS records table + a status footer from validation instructions. */
function printRecords(vi: DomainValidationInstructions): void {
    if (vi.error) {
        throw new CliError(ExitCode.Server, `${vi.error}${vi.message ? `: ${vi.message}` : ''}`);
    }
    log.raw(renderTable({
        head: ['type', 'name', 'value', 'description'],
        rows: (vi.records ?? []).map((r) => [r.type, r.name, r.value, r.description ?? '']),
        maxCellWidth: 120,
    }) + '\n');
    const bits: string[] = [`status: ${statusLabel(vi.status)}`];
    if (vi.cloudflare_status) bits.push(`hostname: ${vi.cloudflare_status}`);
    if (vi.ssl_status) bits.push(`ssl: ${vi.ssl_status}`);
    log.detail(bits.join('  ·  '));
    if (vi.cloudflare_verification_errors) log.warn(vi.cloudflare_verification_errors);
}

export function registerDomainsCommand(program: Command): void {
    const cmd = program
        .command('domains')
        .description('Custom domains — list, add, print DNS records, and validate. To point a page at a domain, see "ef pages settings --domain".')
        .addHelpText('after', `
Attaching pages to a domain is a page setting, not a domain one:

  $ ef pages settings pricing --domain shop.example.com             assign
  $ ef pages settings home --domain shop.example.com --homepage     assign + serve at the root
  $ ef pages settings pricing --domain none                         detach

Typical setup order: "ef domains add", "ef domains records" (create the DNS
entries), "ef domains validate", then attach pages as above.`);

    cmd.command('list')
        .alias('ls')
        .description('List the brand\'s domains.')
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const rows = await api.listDomains(rt.config.brandId);
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'domain', 'type', 'status', 'ssl', 'updated'],
                rows: rows.map((d) => [
                    String(d.id),
                    d.domain ?? '',
                    d.dedicated_domain ? 'dedicated' : 'subdomain',
                    statusLabel(d.status),
                    d.ssl_ready ? 'ready' : (d.ssl_status ?? '-'),
                    formatRelative(d.updated_at),
                ]),
            }) + '\n');
            log.detail(`${rows.length} domains`);
        });

    cmd.command('add <domain>')
        .description('Add a domain. Defaults to a dedicated (customer-owned) domain; use --subdomain for a platform subdomain.')
        .option('--subdomain <label>', 'Create a platform subdomain (e.g. "go") instead of a dedicated domain.')
        .option('--root <root>', 'Subdomain root (defaults to the brand\'s configured root). Only with --subdomain.')
        .option('--merchant-id <id>', 'Associate a merchant id with the domain.')
        .option('--records', 'After adding a dedicated domain, wait for and print the DNS records.')
        .option('--json', 'Print the result as JSON.')
        .action(async (domain: string, opts: { subdomain?: string; root?: string; merchantId?: string; records?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);

            const isSubdomain = Boolean(opts.subdomain);
            const merchantId = opts.merchantId != null ? parseInt(opts.merchantId, 10) : undefined;
            if (opts.merchantId != null && !Number.isFinite(merchantId)) {
                throw new CliError(ExitCode.Validation, `--merchant-id must be a number, got "${opts.merchantId}".`);
            }

            const created = await api.createDomain(rt.config.brandId, isSubdomain
                ? { dedicated_domain: false, subdomain: opts.subdomain, subdomain_root: opts.root, merchant_id: merchantId ?? null }
                : { dedicated_domain: true, domain: domain.trim().toLowerCase(), merchant_id: merchantId ?? null });

            let instructions: DomainValidationInstructions | null = null;
            const dedicated = Boolean(created.dedicated_domain) && !isSubdomain;
            if (dedicated && opts.records) {
                instructions = await waitForRecords(api, rt.config.brandId, created.id);
            }

            if (opts.json) {
                log.json({ ok: true, domain: created, records: instructions });
                return;
            }
            log.success(`Added ${c.bold(created.domain ?? domain)} (#${created.id}) — status: ${statusLabel(created.status)}.`);
            if (dedicated) {
                if (instructions) {
                    log.info('');
                    printRecords(instructions);
                    log.info('');
                    log.detail(`Add these DNS records, then run "ef domains validate ${created.domain}".`);
                } else {
                    log.detail(`Run "ef domains records ${created.domain}" to get the DNS records (they take a few seconds to appear).`);
                }
            }
        });

    cmd.command('records <domain>')
        .alias('dns')
        .description('Print the DNS records (TXT ownership + CNAME) needed to validate a dedicated domain.')
        .option('--wait', 'Poll until the TXT ownership record is available (it is created a few seconds after adding).')
        .option('--json', 'Print as JSON.')
        .action(async (domainRef: string, opts: { wait?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const domain = await resolveDomain(api, rt.config.brandId, domainRef);
            const vi = opts.wait
                ? await waitForRecords(api, rt.config.brandId, domain.id)
                : await api.getDomainValidationInstructions(rt.config.brandId, domain.id);
            if (opts.json) { log.json(vi); return; }
            printRecords(vi);
        });

    cmd.command('validate <domain>')
        .description('Queue validation for a dedicated domain (checks DNS + issues SSL).')
        .option('--json', 'Print as JSON.')
        .action(async (domainRef: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const domain = await resolveDomain(api, rt.config.brandId, domainRef);
            await api.validateDomain(rt.config.brandId, domain.id);
            if (opts.json) { log.json({ ok: true, id: domain.id, domain: domain.domain, queued: true }); return; }
            log.success(`Validation queued for ${c.bold(domain.domain ?? domainRef)}. It may take a few minutes.`);
            log.detail(`Check progress with "ef domains records ${domain.domain}".`);
        });

    cmd.command('remove <domain>')
        .alias('rm')
        .description('Delete a domain from the brand.')
        .option('--json', 'Print as JSON.')
        .action(async (domainRef: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const domain = await resolveDomain(api, rt.config.brandId, domainRef);
            await api.deleteDomain(rt.config.brandId, domain.id);
            if (opts.json) { log.json({ ok: true, id: domain.id, domain: domain.domain, deleted: true }); return; }
            log.success(`Deleted ${c.bold(domain.domain ?? domainRef)} (#${domain.id}).`);
        });
}

/**
 * Poll validation-instructions until the TXT ownership record shows up (or the
 * hostname creation errored). The record is written by an async Cloudflare job,
 * so it isn't present the instant a domain is added.
 */
async function waitForRecords(
    api: ApiClient,
    brandId: number,
    domainId: number,
    opts: { attempts?: number; delayMs?: number } = {},
): Promise<DomainValidationInstructions> {
    const attempts = opts.attempts ?? 15;
    const delayMs = opts.delayMs ?? 2000;
    let last: DomainValidationInstructions | null = null;
    for (let i = 0; i < attempts; i++) {
        last = await api.getDomainValidationInstructions(brandId, domainId);
        const hasTxt = (last.records ?? []).some((r) => r.type === 'TXT' && r.value);
        if (hasTxt) return last;
        if (last.cloudflare_verification_errors) return last;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return last as DomainValidationInstructions;
}
