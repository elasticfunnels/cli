import { BonusRule, Product, ProductBonus } from '../models/product';
import { CliError, ExitCode } from './exit';

/**
 * Per-product bonuses, pick rules and gift orders ("send to a friend").
 *
 * Shared by `ef products bonuses`, `ef products bonus-rule`, the MCP write tool
 * and `ef lint` (the `checkout_settings.bonuses` override), so all four agree
 * on what a valid configuration is. The server validates again (422); these
 * checks exist so a mistake is caught before a round trip, with a message
 * that says what to do instead.
 *
 * The model, in one paragraph: a bonus is a FREE product attached to a main
 * product. The rule says how many the buyer picks — exactly N, up to N, or all.
 * Nothing picked ⇒ the order gets the first N by position (or all). Bonuses
 * flagged giftable can be sent to a friend's address, which creates a separate
 * linked `type: 'gift'` order. Bonuses are not bumps.
 */

export const DEFAULT_MODES = ['first_n', 'all'] as const;
export const GIFT_SHIPPING_MODES = ['same_as_main', 'free', 'fixed'] as const;

/**
 * Product codes are identifiers: letters, digits, `_`, `-`, `.`. A space or a
 * comma almost always means two codes were written as one string
 * (`"SNOOZE,BIOME"`), which the runtime would treat as a single unknown code.
 */
export const PRODUCT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The request shape the product API accepts for `bonuses`. */
export interface BonusInput {
    product_id?: number;
    code?: string;
    position: number;
    quantity: number;
    giftable: boolean;
}

/** A bonus as the CLI edits it: always carries a code when one is known. */
export interface EditableBonus {
    product_id?: number;
    code?: string;
    title?: string;
    quantity: number;
    giftable: boolean;
}

function bad(message: string): CliError {
    return new CliError(ExitCode.Validation, message);
}

/**
 * Normalise the server's `bonuses` into an ordered list. Accepts both the new
 * shape (`product_id`, `code`, `position`, …) and the older `bonus_product_id`
 * only shape, so the CLI can read a server that predates the feature.
 */
export function normalizeBonuses(raw: ProductBonus[] | null | undefined): EditableBonus[] {
    if (!Array.isArray(raw)) return [];
    const rows = raw.map((b, i) => ({ b, i }));
    rows.sort((x, y) => (Number(x.b.position ?? 0) - Number(y.b.position ?? 0)) || (x.i - y.i));
    return rows.map(({ b }) => {
        const id = b.product_id ?? b.bonus_product_id;
        const out: EditableBonus = {
            quantity: b.quantity != null && Number(b.quantity) > 0 ? Number(b.quantity) : 1,
            giftable: !!b.giftable,
        };
        if (id != null && Number.isFinite(Number(id))) out.product_id = Number(id);
        if (b.code) out.code = String(b.code);
        if (b.title) out.title = String(b.title);
        return out;
    });
}

export interface BonusSpec {
    code: string;
    quantity?: number;
    giftable?: boolean;
}

/**
 * Parse `CODE[:qty][:giftable]` (also `CODE:giftable`, `CODE:2`, `CODE:nogift`).
 * The suffixes can come in either order.
 */
export function parseBonusSpec(spec: string): BonusSpec {
    const parts = String(spec).trim().split(':').map(s => s.trim());
    const code = parts.shift() ?? '';
    if (!code) throw bad(`Empty bonus code in "${spec}". Use CODE[:qty][:giftable].`);
    if (!PRODUCT_CODE_RE.test(code)) {
        throw bad(`"${code}" is not a product code (letters, digits, _ - . only). Pass one code per --add; repeat the flag or comma-separate them.`);
    }
    const out: BonusSpec = { code };
    for (const p of parts) {
        const low = p.toLowerCase();
        if (/^\d+$/.test(p)) {
            const n = parseInt(p, 10);
            if (n < 1) throw bad(`Bonus quantity must be at least 1 (got ${p} in "${spec}").`);
            out.quantity = n;
        } else if (low === 'giftable' || low === 'gift') {
            out.giftable = true;
        } else if (low === 'nogift' || low === 'not-giftable' || low === 'no-gift') {
            out.giftable = false;
        } else {
            throw bad(`Unknown part "${p}" in "${spec}". Use CODE[:qty][:giftable], e.g. SNOOZE_MAX:1:giftable.`);
        }
    }
    return out;
}

/** Split repeated/comma-separated flag values into individual entries. */
export function splitList(values: string[] | string | undefined): string[] {
    if (values == null) return [];
    const arr = Array.isArray(values) ? values : [values];
    return arr.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
}

function sameCode(a: string | undefined, b: string | undefined): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export interface BonusEdits {
    clear?: boolean;
    add?: BonusSpec[];
    remove?: string[];
    order?: string[];
    giftable?: string[];
    notGiftable?: string[];
}

/**
 * Apply edits to an ordered bonus list and return the new list. `--clear` runs
 * first, then remove, add (an existing code is updated in place), giftable
 * toggles, and finally the order. Codes match case-insensitively.
 */
export function applyBonusEdits(current: EditableBonus[], edits: BonusEdits): EditableBonus[] {
    let list: EditableBonus[] = edits.clear ? [] : current.map(b => ({ ...b }));

    for (const code of edits.remove ?? []) {
        const before = list.length;
        list = list.filter(b => !sameCode(b.code, code));
        if (list.length === before) throw bad(`"${code}" is not a bonus of this product, so it cannot be removed.`);
    }

    for (const spec of edits.add ?? []) {
        const existing = list.find(b => sameCode(b.code, spec.code));
        if (existing) {
            if (spec.quantity != null) existing.quantity = spec.quantity;
            if (spec.giftable != null) existing.giftable = spec.giftable;
        } else {
            list.push({ code: spec.code, quantity: spec.quantity ?? 1, giftable: spec.giftable ?? false });
        }
    }

    const toggle = (codes: string[] | undefined, value: boolean) => {
        for (const code of codes ?? []) {
            const b = list.find(x => sameCode(x.code, code));
            if (!b) throw bad(`"${code}" is not a bonus of this product. Add it first with --add ${code}.`);
            b.giftable = value;
        }
    };
    toggle(edits.giftable, true);
    toggle(edits.notGiftable, false);

    if (edits.order && edits.order.length) {
        const seen = new Set<string>();
        const head: EditableBonus[] = [];
        for (const code of edits.order) {
            const key = code.toLowerCase();
            if (seen.has(key)) throw bad(`"${code}" appears twice in --order.`);
            seen.add(key);
            const b = list.find(x => sameCode(x.code, code));
            if (!b) throw bad(`"${code}" in --order is not a bonus of this product.`);
            head.push(b);
        }
        list = [...head, ...list.filter(b => !head.includes(b))];
    }

    const codes = new Set<string>();
    for (const b of list) {
        if (!b.code) continue;
        const key = b.code.toLowerCase();
        if (codes.has(key)) throw bad(`"${b.code}" is listed twice as a bonus.`);
        codes.add(key);
    }
    return list;
}

/** The `bonuses` request field: position follows list order. */
export function toBonusPayload(list: EditableBonus[]): BonusInput[] {
    return list.map((b, i) => {
        const row: BonusInput = { position: i, quantity: b.quantity, giftable: b.giftable };
        if (b.product_id != null) row.product_id = b.product_id;
        else if (b.code) row.code = b.code;
        else throw bad('A bonus has neither a product id nor a code.');
        return row;
    });
}

export interface RuleFlags {
    pick?: number;
    upTo?: number;
    all?: boolean;
    min?: number;
    default?: string;
    gift?: string | boolean;
    giftShipping?: string;
    giftPrice?: number;
}

/**
 * Build the rule to send from flags, starting from the current rule (partial
 * edits keep what was there). `bonusCount` is the number of bonuses attached,
 * used to refuse a pick the buyer could never satisfy. Returns the rule plus
 * any warnings worth printing.
 */
export function buildRule(current: BonusRule | null | undefined, flags: RuleFlags, bonusCount: number, giftableCount: number):
    { rule: BonusRule; warnings: string[] } {
    const warnings: string[] = [];
    const modes = [flags.pick != null, flags.upTo != null, !!flags.all].filter(Boolean).length;
    if (modes > 1) throw bad('Pass only one of --pick <n>, --up-to <n> or --all.');
    if (!current && modes === 0) {
        throw bad('This product has no bonus rule yet. Say how many the buyer gets: --pick <n> (exactly n), --up-to <n>, or --all.');
    }

    const rule: BonusRule = current ? { ...current } : {
        min_picks: null,
        max_picks: null,
        default_mode: 'first_n',
        gift_shipping_enabled: false,
        gift_shipping_mode: 'same_as_main',
        gift_shipping_price: null,
    };

    const checkCount = (n: number, flag: string) => {
        if (!Number.isInteger(n) || n < 1) throw bad(`${flag} must be a whole number of at least 1 (got ${n}).`);
        if (bonusCount === 0) throw bad(`This product has no bonuses yet. Attach them first: ef products bonuses <product> --add CODE.`);
        if (n > bonusCount) {
            throw bad(`${flag} ${n} is more than the ${bonusCount} bonus${bonusCount === 1 ? '' : 'es'} attached. Use --all to include every bonus, or attach more.`);
        }
    };

    if (flags.pick != null) {
        checkCount(flags.pick, '--pick');
        rule.min_picks = flags.pick;
        rule.max_picks = flags.pick;
        if (flags.default == null) rule.default_mode = 'first_n';
    } else if (flags.upTo != null) {
        checkCount(flags.upTo, '--up-to');
        rule.min_picks = 1;
        rule.max_picks = flags.upTo;
        if (flags.default == null) rule.default_mode = 'first_n';
    } else if (flags.all) {
        if (bonusCount === 0) throw bad('This product has no bonuses yet. Attach them first: ef products bonuses <product> --add CODE.');
        rule.min_picks = null;
        rule.max_picks = null;
        rule.default_mode = 'all';
    }

    if (flags.min != null) {
        if (!Number.isInteger(flags.min) || flags.min < 0) throw bad(`--min must be a whole number ≥ 0 (got ${flags.min}).`);
        rule.min_picks = flags.min;
    }
    if (rule.max_picks != null && rule.min_picks != null && rule.min_picks > rule.max_picks) {
        throw bad(`The minimum (${rule.min_picks}) is more than the maximum (${rule.max_picks}).`);
    }
    if (rule.max_picks != null && bonusCount > 0 && rule.max_picks > bonusCount) {
        throw bad(`The rule allows ${rule.max_picks} picks but only ${bonusCount} bonus${bonusCount === 1 ? ' is' : 'es are'} attached.`);
    }

    if (flags.default != null) {
        if (!(DEFAULT_MODES as readonly string[]).includes(flags.default)) {
            throw bad(`--default must be first_n or all (got "${flags.default}").`);
        }
        rule.default_mode = flags.default as BonusRule['default_mode'];
    }

    if (flags.gift != null) {
        const v = String(flags.gift).toLowerCase();
        if (['on', 'true', 'yes', '1'].includes(v)) rule.gift_shipping_enabled = true;
        else if (['off', 'false', 'no', '0'].includes(v)) rule.gift_shipping_enabled = false;
        else throw bad(`--gift must be on or off (got "${flags.gift}").`);
    }
    if (flags.giftShipping != null) {
        if (!(GIFT_SHIPPING_MODES as readonly string[]).includes(flags.giftShipping)) {
            throw bad(`--gift-shipping must be same_as_main, free or fixed (got "${flags.giftShipping}").`);
        }
        rule.gift_shipping_mode = flags.giftShipping as BonusRule['gift_shipping_mode'];
    }
    if (flags.giftPrice != null) {
        if (!Number.isFinite(flags.giftPrice) || flags.giftPrice < 0) throw bad(`--gift-price must be a price ≥ 0 (got ${flags.giftPrice}).`);
        rule.gift_shipping_price = flags.giftPrice;
        if (flags.giftShipping == null) rule.gift_shipping_mode = 'fixed';
    }
    if (rule.gift_shipping_mode === 'fixed' && (rule.gift_shipping_price == null || !Number.isFinite(rule.gift_shipping_price))) {
        throw bad('--gift-shipping fixed needs a price: add --gift-price <amount>.');
    }
    if (rule.gift_shipping_mode !== 'fixed' && flags.giftShipping != null) rule.gift_shipping_price = null;

    if (rule.gift_shipping_enabled && giftableCount === 0) {
        warnings.push('Gift shipping is on, but no bonus is giftable, so the buyer will never see the "send to a friend" option. Mark bonuses with: ef products bonuses <product> --giftable CODE.');
    }
    return { rule, warnings };
}

/** One-line human description of a rule: "pick exactly 1 of 3 · gift: same_as_main". */
export function describeRule(rule: BonusRule | null | undefined, bonusCount: number): string {
    if (!rule) return bonusCount ? `no rule (all ${bonusCount} included; not active on the internal checkout)` : 'no rule';
    let pick: string;
    if (rule.max_picks == null) pick = `all ${bonusCount} included`;
    else if (rule.min_picks != null && rule.min_picks === rule.max_picks) pick = `pick exactly ${rule.max_picks} of ${bonusCount}`;
    else pick = `pick up to ${rule.max_picks} of ${bonusCount}${rule.min_picks ? ` (min ${rule.min_picks})` : ''}`;
    if (rule.max_picks != null) pick += `, none picked → ${rule.default_mode === 'all' ? 'all' : `first ${rule.max_picks}`}`;
    const gift = rule.gift_shipping_enabled
        ? `gift: on, shipping ${rule.gift_shipping_mode}${rule.gift_shipping_mode === 'fixed' ? ` ${rule.gift_shipping_price}` : ''}`
        : 'gift: off';
    return `${pick} · ${gift}`;
}

/** Compact summary for the products table. */
export function bonusSummary(p: Product): string {
    const list = Array.isArray(p.bonuses) ? p.bonuses : [];
    if (!list.length && !p.bonus_rule) return '';
    const r = p.bonus_rule;
    if (!r) return `${list.length}`;
    if (r.max_picks == null) return `${list.length} (all)`;
    const exact = r.min_picks != null && r.min_picks === r.max_picks;
    return `${list.length} (${exact ? 'pick' : 'up to'} ${r.max_picks})${r.gift_shipping_enabled ? ' +gift' : ''}`;
}

// ── checkout_settings.bonuses override ────────────────────────────────

export interface OverrideIssue {
    severity: 'error' | 'warning';
    message: string;
}

/** Sentinel for a value the linter cannot evaluate statically. */
export const UNKNOWN: unique symbol = Symbol('unknown');

const OVERRIDE_KEYS = new Set(['options', 'min', 'max', 'default', 'gift_shipping']);
const OPTION_KEYS = new Set(['code', 'giftable', 'quantity']);
const GIFT_KEYS = new Set(['enabled', 'mode', 'price']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a page/funnel bonus override:
 *   { "<MAIN_CODE>": { options: ["CODE" | { code, giftable, quantity }], min, max,
 *                      default: "first_n"|"all", gift_shipping: { enabled, mode, price } } }
 * `options: []` switches bonuses off for that page. Values the caller could not
 * evaluate are passed as UNKNOWN and skipped.
 */
export function validateBonusOverride(map: unknown, opts: { bumps?: string[] } = {}): OverrideIssue[] {
    const issues: OverrideIssue[] = [];
    const err = (message: string) => issues.push({ severity: 'error', message });
    const warn = (message: string) => issues.push({ severity: 'warning', message });
    if (map === UNKNOWN || map == null) return issues;
    if (!isPlainObject(map)) {
        err('checkout_settings.bonuses must be an object keyed by the MAIN product code: { "MAIN_CODE": { options: ["BONUS_CODE", …], min, max } }.');
        return issues;
    }
    if ('options' in map || 'min' in map || 'max' in map) {
        err('checkout_settings.bonuses is keyed by the MAIN product code — wrap the rule: { "MAIN_CODE": { options: [...], min, max } }.');
        return issues;
    }
    const bumpSet = new Set((opts.bumps ?? []).map(c => c.toLowerCase()));

    for (const [main, rule] of Object.entries(map)) {
        const where = `checkout_settings.bonuses["${main}"]`;
        if (!PRODUCT_CODE_RE.test(main)) err(`${where}: "${main}" is not a product code — the key must be the main product's code.`);
        if (rule === UNKNOWN) continue;
        if (!isPlainObject(rule)) { err(`${where} must be an object: { options: [...], min, max, default, gift_shipping }.`); continue; }

        for (const k of Object.keys(rule)) {
            if (!OVERRIDE_KEYS.has(k)) warn(`${where}: unknown key "${k}" (expected options, min, max, default, gift_shipping) — the runtime ignores it.`);
        }

        let optionCount: number | null = null;
        let giftableKnown = true;
        let anyGiftable = false;
        const options = rule.options;
        if (options === undefined) {
            warn(`${where} has no options — the product's own bonus list is used. Set options: [] to switch bonuses off on this page.`);
        } else if (options !== UNKNOWN) {
            if (!Array.isArray(options)) {
                err(`${where}.options must be an array of bonus codes or { code, giftable, quantity } objects.`);
            } else {
                optionCount = options.length;
                const seen = new Set<string>();
                options.forEach((opt, i) => {
                    let code: unknown;
                    if (opt === UNKNOWN) { giftableKnown = false; optionCount = null; return; }
                    if (typeof opt === 'string') { code = opt; giftableKnown = false; }
                    else if (isPlainObject(opt)) {
                        code = opt.code;
                        for (const k of Object.keys(opt)) {
                            if (!OPTION_KEYS.has(k)) warn(`${where}.options[${i}]: unknown key "${k}" (expected code, giftable, quantity).`);
                        }
                        if (opt.giftable === true) anyGiftable = true;
                        else if (opt.giftable === UNKNOWN) giftableKnown = false;
                        if (opt.quantity !== undefined && opt.quantity !== UNKNOWN
                            && !(typeof opt.quantity === 'number' && Number.isInteger(opt.quantity) && opt.quantity >= 1)) {
                            err(`${where}.options[${i}].quantity must be a whole number ≥ 1.`);
                        }
                    } else {
                        err(`${where}.options[${i}] must be a code string or { code, giftable, quantity }.`);
                        return;
                    }
                    if (code === UNKNOWN) return;
                    if (typeof code !== 'string' || !PRODUCT_CODE_RE.test(code)) {
                        const hint = typeof code === 'string' && /[,\s]/.test(code) ? ' — list each code as its own array entry' : '';
                        err(`${where}.options[${i}]: ${JSON.stringify(code)} is not a product code${hint}.`);
                        return;
                    }
                    const key = code.toLowerCase();
                    if (seen.has(key)) err(`${where}.options: "${code}" is listed twice.`);
                    seen.add(key);
                    if (key === main.toLowerCase()) err(`${where}.options: the main product "${code}" cannot be its own bonus.`);
                    if (bumpSet.has(key)) {
                        err(`"${code}" is both a bump and a bonus. Bonuses are not bumps — drop it from checkout_settings.bumps; the bonus line is added at $0 by the runtime.`);
                    }
                });
            }
        }

        const num = (k: 'min' | 'max'): number | null | undefined => {
            const v = rule[k];
            if (v === undefined || v === UNKNOWN) return undefined;
            if (v === null) {
                if (k === 'min') err(`${where}.min must be a whole number ≥ 0.`);
                return null; // max: null = all
            }
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
                err(`${where}.${k} must be a whole number ≥ 0${k === 'max' ? ' (or null for all)' : ''}.`);
                return undefined;
            }
            return v;
        };
        const min = num('min');
        const max = num('max');
        if (typeof min === 'number' && typeof max === 'number' && min > max) err(`${where}: min (${min}) is more than max (${max}).`);
        if (optionCount != null) {
            if (typeof max === 'number' && max > optionCount) err(`${where}: max ${max} is more than the ${optionCount} option${optionCount === 1 ? '' : 's'} offered — the buyer can never pick that many. Use max: null for "all".`);
            if (typeof min === 'number' && min > optionCount) err(`${where}: min ${min} is more than the ${optionCount} option${optionCount === 1 ? '' : 's'} offered.`);
        }

        if (rule.default !== undefined && rule.default !== UNKNOWN && !(DEFAULT_MODES as readonly unknown[]).includes(rule.default)) {
            err(`${where}.default must be "first_n" or "all" (got ${JSON.stringify(rule.default)}).`);
        }

        const gs = rule.gift_shipping;
        if (gs !== undefined && gs !== UNKNOWN && gs !== null) {
            if (!isPlainObject(gs)) {
                err(`${where}.gift_shipping must be { enabled, mode, price }.`);
            } else {
                for (const k of Object.keys(gs)) {
                    if (!GIFT_KEYS.has(k)) warn(`${where}.gift_shipping: unknown key "${k}" (expected enabled, mode, price).`);
                }
                if (gs.mode !== undefined && gs.mode !== UNKNOWN && !(GIFT_SHIPPING_MODES as readonly unknown[]).includes(gs.mode)) {
                    err(`${where}.gift_shipping.mode must be "same_as_main", "free" or "fixed" (got ${JSON.stringify(gs.mode)}).`);
                }
                if (gs.mode === 'fixed' && (gs.price === undefined || gs.price === null)) {
                    err(`${where}.gift_shipping.mode "fixed" needs a price.`);
                }
                if (gs.price !== undefined && gs.price !== UNKNOWN && gs.price !== null && !(typeof gs.price === 'number' && gs.price >= 0)) {
                    err(`${where}.gift_shipping.price must be a number ≥ 0.`);
                }
                if (gs.enabled === true && optionCount != null && optionCount > 0 && giftableKnown && !anyGiftable) {
                    warn(`${where}: gift_shipping is enabled but no option is giftable, so "send to a friend" never shows. Mark them { code, giftable: true }.`);
                }
            }
        }
    }
    return issues;
}
