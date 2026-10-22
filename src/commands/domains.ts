import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { BrandDomain, DomainMoveChange, DomainMovePreview, DomainValidationInstructions } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { formatRelative, renderTable } from '../utils/format';
import { safeText } from '../utils/sanitize';

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

    cmd.command('move <domain>')
        .description('Move a domain to another brand of the same organization. No DNS re-verification; the domain stays live.')
        .requiredOption('--to-brand <brand>', 'Target brand: id, code or name.')
        .option('--with-pages', 'Move the pages on this domain too (queued; can take a few minutes).')
        .option('--components <action>', 'With --with-pages: "move" or "copy" the custom components those pages use.')
        .option('--dry-run', 'Show what would change and stop.')
        .option('-y, --yes', 'Skip the confirmation prompt (required when not on a terminal).')
        .option('--json', 'Print the preview / result as JSON.')
        .addHelpText('after', `
Without --with-pages the pages on the domain stay in this brand, unassigned.
Funnels, blogs, courses and tracking scripts in this brand let go of the
domain either way. You need domains.update in both brands.

  $ ef domains move shop.example.com --to-brand 512 --dry-run
  $ ef domains move shop.example.com --to-brand "Main Store" --with-pages --components copy --yes`)
        .action(async (domainRef: string, opts: { toBrand: string; withPages?: boolean; components?: string; dryRun?: boolean; yes?: boolean; json?: boolean }) => {
            if (opts.components !== undefined && !opts.withPages) {
                throw new CliError(ExitCode.Validation, '--components only applies with --with-pages.');
            }
            if (opts.components !== undefined && opts.components !== 'move' && opts.components !== 'copy') {
                throw new CliError(ExitCode.Validation, `--components must be "move" or "copy", got "${opts.components}".`);
            }
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const domain = await resolveDomain(api, rt.config.brandId, domainRef);
            const target = await resolveTargetBrand(api, opts.toBrand);
            if (target.id === rt.config.brandId) {
                throw new CliError(ExitCode.Validation, 'The domain is already in that brand.');
            }
            const moveOpts = {
                target_brand_id: target.id,
                move_pages: Boolean(opts.withPages),
                component_action: opts.withPages ? ((opts.components as 'move' | 'copy' | undefined) ?? null) : null,
            };

            const preview = await api.previewDomainMove(rt.config.brandId, domain.id, moveOpts);
            if (opts.dryRun) {
                if (opts.json) { log.json({ ok: true, dry_run: true, preview }); return; }
                printMovePreview(domain, target, preview);
                log.detail('Dry run: nothing changed.');
                return;
            }
            if (!opts.json) printMovePreview(domain, target, preview);

            if (!opts.yes) {
                if (!process.stdin.isTTY) {
                    throw new CliError(ExitCode.Validation, 'Moving a domain changes which brand serves it. Re-run with --yes to confirm.');
                }
                const { confirm } = await import('../utils/prompt');
                if (!(await confirm(`Move ${safeText(domain.domain)} to brand #${target.id}?`, false))) {
                    throw new CliError(ExitCode.Validation, 'Cancelled.');
                }
            }

            const result = await api.applyDomainMove(rt.config.brandId, domain.id, moveOpts);
            if (opts.json) { log.json({ ok: true, id: domain.id, domain: domain.domain, target_brand_id: target.id, ...result }); return; }
            if (result.moved) {
                log.success(`Moved ${c.bold(safeText(domain.domain))} (#${domain.id}) to brand #${target.id}.`);
                for (const w of result.result?.warnings ?? []) log.detail(safeText(w));
                log.detail(`It is no longer in this brand's "ef domains list"; manage it from a folder linked to brand #${target.id}.`);
            } else {
                log.success(`Move of ${c.bold(safeText(domain.domain))} to brand #${target.id} queued. Pages move in the background.`);
                log.detail('When it is done the domain leaves this brand\'s "ef domains list".');
            }
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

/** Resolve --to-brand: a numeric id, or a brand code/name from the brands you can access. */
export async function resolveTargetBrand(api: ApiClient, ref: string): Promise<{ id: number; name?: string }> {
    const trimmed = ref.trim();
    if (/^\d+$/.test(trimmed)) return { id: parseInt(trimmed, 10) };
    const needle = trimmed.toLowerCase();
    const brands = await api.listBrands();
    const hits = brands.filter((b) => [b.name, b.slug, (b as { code?: string }).code]
        .some((v) => typeof v === 'string' && v.toLowerCase() === needle));
    if (hits.length === 1) return { id: hits[0].id, name: hits[0].name };
    if (hits.length > 1) {
        throw new CliError(ExitCode.Validation, `"${ref}" matches ${hits.length} brands (${hits.map((b) => `#${b.id}`).join(', ')}). Pass the id.`);
    }
    throw new CliError(ExitCode.NotFound, `No brand "${ref}" among the brands you can access. Pass the brand id.`);
}

/** One line per change the move makes, for the confirmation screen. */
export function describeMoveChanges(preview: DomainMovePreview): string[] {
    const lines: string[] = [];
    const n = (v: number | undefined, word: string) => `${v ?? 0} ${word}${v === 1 ? '' : 's'}`;
    for (const ch of preview.changes ?? []) {
        switch (ch.type) {
            case 'domain_transfer':
                lines.push(`Domain moves to brand #${preview.target_brand_id}. DNS, SSL and validation stay as they are.`);
                break;
            case 'pages_unassign':
                lines.push(`${n(ch.count, 'page')} on this domain ${ch.count === 1 ? 'stays' : 'stay'} in this brand, without a domain (pass --with-pages to move them).`);
                break;
            case 'pages_move':
                lines.push(`${n(ch.count, 'page')} ${ch.count === 1 ? 'moves' : 'move'} with the domain.`);
                break;
            case 'components':
                lines.push(`Components: ${ch.move_count ?? 0} moved, ${ch.copy_count ?? 0} copied.`);
                break;
            case 'links_unassign':
                lines.push(...unlinkLines(ch));
                break;
            default:
                break;
        }
    }
    return lines;
}

function unlinkLines(ch: DomainMoveChange): string[] {
    const parts: string[] = [];
    if (ch.funnels) parts.push(`${ch.funnels} funnel link${ch.funnels === 1 ? '' : 's'}`);
    if (ch.blogs) parts.push(`${ch.blogs} blog${ch.blogs === 1 ? '' : 's'}`);
    if (ch.courses) parts.push(`${ch.courses} course${ch.courses === 1 ? '' : 's'}`);
    if (ch.course_domain) parts.push('the courses domain setting');
    if (ch.tracking_scripts) parts.push(`${ch.tracking_scripts} tracking script${ch.tracking_scripts === 1 ? '' : 's'}`);
    const out = parts.length ? [`Stop using it in this brand: ${parts.join(', ')}.`] : [];
    if (ch.merchant) out.push('Its merchant belongs to this brand and is removed from the domain.');
    return out;
}

function printMovePreview(domain: BrandDomain, target: { id: number; name?: string }, preview: DomainMovePreview): void {
    const name = target.name ? ` (${safeText(target.name)})` : '';
    log.info(`Move ${c.bold(safeText(domain.domain))} (#${domain.id}) to brand #${target.id}${name}:`);
    for (const line of describeMoveChanges(preview)) log.detail(`  - ${line}`);
    for (const w of preview.warnings ?? []) log.warn(safeText(w));
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
