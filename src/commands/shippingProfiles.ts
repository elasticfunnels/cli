import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { Product, ShippingOverride, ShippingProfile } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';

/**
 * `ef shipping-profiles` — the brand's shipping rates and which products use them.
 *
 * A product with no profile ships free, and so does a region whose rate is left
 * empty. Kits that charge shipping on the 1-unit pack (and ship bundles free) do
 * it by giving only the 1-unit product a profile.
 */

type Costs = NonNullable<ShippingProfile['shipping_costs']>;

/** A rate flag: a non-negative amount, or "none"/"free"/"" for an empty rate (free in that region). */
export function parseRate(flag: string, value: string): number | null {
    const v = value.trim().replace(/^\$/, '');
    if (v === '' || /^(none|null|free|-)$/i.test(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
        throw new CliError(ExitCode.Validation, `${flag} takes an amount like 6.95, or "none" for no rate (got "${value}").`);
    }
    return Math.round(n * 100) / 100;
}

/** `--override CA:9.95` → { country_code: 'CA', cost: 9.95 }. */
export function parseOverride(spec: string): ShippingOverride {
    const m = /^\s*([a-z]{2})\s*[:=]\s*\$?([0-9]+(?:\.[0-9]+)?)\s*$/i.exec(spec);
    if (!m) throw new CliError(ExitCode.Validation, `--override takes COUNTRY:amount, e.g. CA:9.95 (got "${spec}").`);
    return { country_code: m[1].toUpperCase(), cost: Math.round(Number(m[2]) * 100) / 100 };
}

export interface RateFlags {
    us?: string;
    intl?: string;
    override?: string[];
    removeOverride?: string[];
    clearOverrides?: boolean;
}

/**
 * The shipping_costs to send: the current ones with the flags applied. The
 * server replaces the whole object, so an update always carries all three parts.
 */
export function mergeCosts(current: ShippingProfile['shipping_costs'], flags: RateFlags): Costs {
    const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
    const out: Costs = {
        us_mainland: num(current?.us_mainland),
        international: num(current?.international),
        overrides: flags.clearOverrides ? [] : (current?.overrides ?? []).map((o) => ({ country_code: String(o.country_code).toUpperCase(), cost: Number(o.cost) })),
    };
    if (flags.us !== undefined) out.us_mainland = parseRate('--us', flags.us);
    if (flags.intl !== undefined) out.international = parseRate('--intl', flags.intl);
    const drop = new Set((flags.removeOverride ?? []).flatMap((x) => x.split(',')).map((x) => x.trim().toUpperCase()).filter(Boolean));
    let overrides = (out.overrides ?? []).filter((o) => !drop.has(o.country_code));
    for (const spec of flags.override ?? []) {
        const o = parseOverride(spec);
        overrides = overrides.filter((x) => x.country_code !== o.country_code).concat(o);
    }
    out.overrides = overrides;
    return out;
}

export function rateLabel(v: unknown): string {
    if (v === null || v === undefined || v === '') return 'free (no rate)';
    const n = Number(v);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
}

/** By numeric id (optionally "#12") or by name, case-insensitive; an ambiguous name is refused. */
export function findProfile(profiles: ShippingProfile[], ref: string): ShippingProfile | null {
    const r = ref.trim().replace(/^#/, '');
    if (/^\d+$/.test(r)) return profiles.find((p) => Number(p.id) === Number(r)) ?? null;
    const hits = profiles.filter((p) => (p.name ?? '').trim().toLowerCase() === r.toLowerCase());
    if (hits.length > 1) throw new CliError(ExitCode.Validation, `"${ref}" matches ${hits.length} profiles. Pass the numeric id.`);
    return hits[0] ?? null;
}

async function requireProfile(api: ApiClient, brandId: number, ref: string): Promise<ShippingProfile> {
    const hit = findProfile(await api.listShippingProfiles(brandId), ref);
    if (!hit) throw new CliError(ExitCode.NotFound, `No shipping profile "${ref}" in this brand. Run "ef shipping-profiles list".`);
    return hit;
}

/** Product codes or ids → products of this brand; every unknown ref is named in one error. */
export function matchProducts(all: Product[], refs: string[]): Product[] {
    const out: Product[] = [];
    const missing: string[] = [];
    for (const raw of refs.flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean)) {
        const id = /^#?\d+$/.test(raw) ? Number(raw.replace('#', '')) : null;
        const hit = all.find((p) => (id !== null && p.id === id) || (p.code ?? '').toLowerCase() === raw.toLowerCase());
        if (!hit) missing.push(raw);
        else if (!out.some((p) => p.id === hit.id)) out.push(hit);
    }
    if (missing.length) throw new CliError(ExitCode.NotFound, `No product ${missing.map((m) => `"${m}"`).join(', ')} in this brand. List them with: ef products list`);
    return out;
}

function printProfile(p: ShippingProfile, products?: Product[] | null): void {
    const costs = p.shipping_costs ?? {};
    log.info(`${c.bold(p.name)} (#${p.id})${p.is_default ? ' default' : ''}`);
    if (p.description) log.detail(`  ${p.description}`);
    log.info(`  US:            ${rateLabel(costs.us_mainland)}`);
    log.info(`  International: ${rateLabel(costs.international)}`);
    for (const o of costs.overrides ?? []) log.info(`  ${String(o.country_code).padEnd(15)}${rateLabel(o.cost)}`);
    if (products) {
        log.info(products.length ? `  Products: ${products.map((x) => x.code ?? `#${x.id}`).join(', ')}` : '  Products: none (assign with "ef shipping-profiles assign <product> --profile ' + p.id + '")');
    }
}

function profileFlags(cmd: Command): Command {
    return cmd
        .option('--us <amount>', 'US (Mainland US) rate, e.g. 6.95; "none" leaves the US free.')
        .option('--intl <amount>', 'International rate (every other country); "none" leaves it free.')
        .option('--override <CC:amount>', 'Per-country rate, e.g. CA:9.95 (repeatable).', (v: string, prev: string[] = []) => [...prev, v])
        .option('--description <text>', 'Internal description.')
        .option('--default', 'Make this the brand\'s default profile.')
        .option('--json', 'Print the profile as JSON.');
}

export function registerShippingProfilesCommand(program: Command): void {
    const cmd = program
        .command('shipping-profiles')
        .alias('shipping')
        .description('Shipping rates (Products → Shipping Profiles): list, create, update, and assign them to products.')
        .addHelpText('after', `
At checkout the buyer's country picks ONE rate: a per-country override, else the
US rate for US buyers, else the International rate. An empty rate means free
shipping in that region, and a product with no profile ships free everywhere.

  $ ef shipping-profiles list
  $ ef shipping-profiles create "Single jar" --us 6.95 --intl 14.95
  $ ef shipping-profiles assign JAR-1 --profile "Single jar"     1-jar pack pays shipping
  $ ef shipping-profiles assign JAR-1 --none                     ships free again
  $ ef shipping-profiles update "Single jar" --us 5.95 --override CA:9.95
  $ ef shipping-profiles get "Single jar"                        rates + products using it

Bundles that ship free simply get no profile (or a profile with no rates).
Upsell products are separate orders: give them their own profile if they pay
shipping.`);

    cmd.command('list')
        .alias('ls')
        .description('Every profile with its rates and product count.')
        .option('--json', 'Print as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const profiles = await api.listShippingProfiles(rt.config.brandId);
            const products = await api.listProducts(rt.config.brandId);
            const knowsProfile = products.some((p) => 'shipping_profile_id' in p);
            const count = (id: number): string => knowsProfile
                ? String(products.filter((p) => Number(p.shipping_profile_id) === Number(id)).length)
                : '?';
            if (opts.json) {
                log.json({ ok: true, profiles: profiles.map((p) => ({ ...p, products_count: knowsProfile ? Number(count(p.id)) : p.products_count ?? null })) });
                return;
            }
            if (!profiles.length) {
                log.info('No shipping profiles yet. Every product ships free. Create one: ef shipping-profiles create "Standard" --us 5.95 --intl 14.95');
                return;
            }
            log.raw(renderTable({
                head: ['id', 'name', 'US', 'international', 'overrides', 'products', 'default'],
                rows: profiles.map((p) => [
                    String(p.id), p.name, rateLabel(p.shipping_costs?.us_mainland), rateLabel(p.shipping_costs?.international),
                    (p.shipping_costs?.overrides ?? []).map((o) => `${o.country_code} ${rateLabel(o.cost)}`).join(', '),
                    count(p.id), p.is_default ? 'yes' : '',
                ]),
            }) + '\n');
        });

    cmd.command('get <nameOrId>')
        .alias('show')
        .description('One profile: its rates and the products that use it.')
        .option('--json', 'Print as JSON.')
        .action(async (ref: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const hit = await requireProfile(api, rt.config.brandId, ref);
            const profile = await api.getShippingProfile(rt.config.brandId, hit.id);
            const all = await api.listProducts(rt.config.brandId);
            const products = all.some((p) => 'shipping_profile_id' in p) ? all.filter((p) => Number(p.shipping_profile_id) === Number(hit.id)) : null;
            if (opts.json) { log.json({ ok: true, profile, products: products?.map((p) => ({ id: p.id, code: p.code, title: p.title })) ?? null }); return; }
            printProfile(profile, products);
        });

    profileFlags(cmd.command('create <name>'))
        .description('Create a profile. Rates left out are empty (free in that region).')
        .action(async (name: string, opts: RateFlags & { description?: string; default?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            if (opts.us === undefined && opts.intl === undefined && !opts.override?.length) {
                log.warn('No rate given: this profile charges nothing anywhere. Pass --us / --intl / --override to charge shipping.');
            }
            const payload: Record<string, unknown> = { name: name.trim(), shipping_costs: mergeCosts(null, opts) };
            if (opts.description !== undefined) payload.description = opts.description;
            if (opts.default) payload.is_default = true;
            const created = await api.createShippingProfile(rt.config.brandId, payload);
            if (opts.json) { log.json({ ok: true, profile: created }); return; }
            log.success(`Created shipping profile ${c.bold(created.name)} (#${created.id}).`);
            printProfile(created);
            log.detail(`Put it on a product: ef shipping-profiles assign <product-code> --profile ${created.id}`);
        });

    profileFlags(cmd.command('update <nameOrId>'))
        .description('Change a profile\'s rates, name or description. Rates not passed are kept.')
        .option('--name <name>', 'Rename it.')
        .option('--remove-override <CC>', 'Drop a per-country rate (repeatable or comma-separated).', (v: string, prev: string[] = []) => [...prev, v])
        .option('--clear-overrides', 'Drop every per-country rate (before --override).')
        .action(async (ref: string, opts: RateFlags & { name?: string; description?: string; default?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const hit = await requireProfile(api, rt.config.brandId, ref);
            const current = await api.getShippingProfile(rt.config.brandId, hit.id);
            const touchesRates = opts.us !== undefined || opts.intl !== undefined || !!opts.override?.length || !!opts.removeOverride?.length || !!opts.clearOverrides;
            const payload: Record<string, unknown> = {};
            if (touchesRates) payload.shipping_costs = mergeCosts(current.shipping_costs, opts);
            if (opts.name !== undefined) payload.name = opts.name.trim();
            if (opts.description !== undefined) payload.description = opts.description;
            if (opts.default) payload.is_default = true;
            if (!Object.keys(payload).length) throw new CliError(ExitCode.Validation, 'Nothing to change. Pass --us, --intl, --override, --name, --description or --default.');
            // Older servers require the name on every update.
            if (payload.name === undefined) payload.name = current.name;
            const updated = await api.updateShippingProfile(rt.config.brandId, hit.id, payload);
            if (opts.json) { log.json({ ok: true, profile: updated }); return; }
            log.success(`Updated shipping profile ${c.bold(updated.name)} (#${updated.id}).`);
            printProfile(updated);
        });

    cmd.command('assign <products...>')
        .description('Give products (codes or ids) a shipping profile, or take it off with --none.')
        .option('--profile <nameOrId>', 'The profile to assign.')
        .option('--none', 'Remove the profile: the products ship free.')
        .option('--json', 'Print the result as JSON.')
        .action(async (refs: string[], opts: { profile?: string; none?: boolean; json?: boolean }) => {
            if (!!opts.profile === !!opts.none) throw new CliError(ExitCode.Validation, 'Pass exactly one of --profile <nameOrId> or --none.');
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const profile = opts.profile ? await requireProfile(api, rt.config.brandId, opts.profile) : null;
            const products = matchProducts(await api.listProducts(rt.config.brandId), refs);
            const updated = await api.assignShippingProfile(rt.config.brandId, products.map((p) => p.id), profile ? profile.id : null);
            const codes = products.map((p) => p.code ?? `#${p.id}`);
            if (opts.json) { log.json({ ok: true, profile: profile ? { id: profile.id, name: profile.name } : null, products: products.map((p) => ({ id: p.id, code: p.code })), updated }); return; }
            log.success(profile
                ? `${codes.join(', ')} now use${codes.length === 1 ? 's' : ''} ${c.bold(profile.name)} (#${profile.id}).`
                : `${codes.join(', ')} no longer ha${codes.length === 1 ? 's' : 've'} a shipping profile (free shipping).`);
            if (profile) printProfile(profile);
        });
}
