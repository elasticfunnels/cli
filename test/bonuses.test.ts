import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import {
    applyBonusEdits,
    bonusSummary,
    buildRule,
    describeRule,
    normalizeBonuses,
    parseBonusSpec,
    splitList,
    toBonusPayload,
    validateBonusOverride,
} from '../src/utils/bonuses';
import { lintEfContent } from '../src/lint/lintEf';
import { installBundledSkills } from '../src/commands/claude';
import { BonusRule } from '../src/models/product';
import { CliError } from '../src/utils/exit';

/**
 * Bonuses and gift orders fail quietly when misconfigured: a pick the rule can
 * never satisfy, a fixed gift price with no amount, or a bonus that is also a
 * bump (sold as a $0 bump). These tests pin the client-side checks that catch
 * them before the server's 422 does.
 */

function caught(fn: () => unknown): CliError {
    try { fn(); } catch (err) {
        assert.ok(err instanceof CliError, `expected a CliError, got ${err}`);
        return err;
    }
    throw new assert.AssertionError({ message: 'expected the call to throw' });
}

const RULE: BonusRule = {
    min_picks: 1, max_picks: 1, default_mode: 'first_n',
    gift_shipping_enabled: false, gift_shipping_mode: 'same_as_main', gift_shipping_price: null,
};

// ── --add spec ───────────────────────────────────────────────────────

test('bonus spec: code, quantity and giftable in either order', () => {
    assert.deepEqual(parseBonusSpec('SNOOZE'), { code: 'SNOOZE' });
    assert.deepEqual(parseBonusSpec('SNOOZE:2'), { code: 'SNOOZE', quantity: 2 });
    assert.deepEqual(parseBonusSpec('SNOOZE:giftable'), { code: 'SNOOZE', giftable: true });
    assert.deepEqual(parseBonusSpec('SNOOZE:giftable:3'), { code: 'SNOOZE', quantity: 3, giftable: true });
    assert.deepEqual(parseBonusSpec('SNOOZE:nogift'), { code: 'SNOOZE', giftable: false });
});

test('bonus spec: rejects a zero quantity, junk suffixes and two codes in one', () => {
    assert.match(caught(() => parseBonusSpec('SNOOZE:0')).message, /at least 1/);
    assert.match(caught(() => parseBonusSpec('SNOOZE:free')).message, /Unknown part/);
    assert.match(caught(() => parseBonusSpec('SNOOZE BIOME')).message, /not a product code/);
});

test('splitList flattens repeated and comma-separated flags', () => {
    assert.deepEqual(splitList(['A,B', ' C ']), ['A', 'B', 'C']);
    assert.deepEqual(splitList(undefined), []);
});

// ── list edits ───────────────────────────────────────────────────────

test('normalizeBonuses orders by position and reads the legacy bonus_product_id shape', () => {
    const list = normalizeBonuses([
        { product_id: 2, code: 'B', position: 1, quantity: 1, giftable: true },
        { product_id: 1, code: 'A', position: 0 },
        { bonus_product_id: 9 },
    ]);
    assert.deepEqual(list.map(b => b.code ?? b.product_id), ['A', 9, 'B']);
    assert.equal(list.find(b => b.code === 'B')!.giftable, true);
    assert.equal(list.find(b => b.product_id === 9)!.quantity, 1);
});

test('applyBonusEdits: add updates in place, remove, giftable toggles and order', () => {
    const current = normalizeBonuses([
        { product_id: 1, code: 'A', position: 0 },
        { product_id: 2, code: 'B', position: 1 },
    ]);
    const next = applyBonusEdits(current, {
        add: [parseBonusSpec('C:giftable'), parseBonusSpec('a:3')],
        remove: ['B'],
        giftable: ['A'],
        order: ['C'],
    });
    assert.deepEqual(next.map(b => b.code), ['C', 'A']);
    assert.equal(next[1].quantity, 3);
    assert.equal(next[1].giftable, true);
    assert.deepEqual(toBonusPayload(next), [
        { position: 0, quantity: 1, giftable: true, code: 'C' },
        { position: 1, quantity: 3, giftable: true, product_id: 1 },
    ]);
});

test('applyBonusEdits: --clear then --add replaces the list; unknown codes are refused', () => {
    const current = normalizeBonuses([{ product_id: 1, code: 'A' }]);
    assert.deepEqual(applyBonusEdits(current, { clear: true, add: [{ code: 'Z' }] }).map(b => b.code), ['Z']);
    assert.match(caught(() => applyBonusEdits(current, { remove: ['NOPE'] })).message, /not a bonus/);
    assert.match(caught(() => applyBonusEdits(current, { order: ['A', 'A'] })).message, /twice/);
    assert.match(caught(() => applyBonusEdits(current, { giftable: ['NOPE'] })).message, /Add it first/);
});

// ── rule ─────────────────────────────────────────────────────────────

test('buildRule: pick, up-to and all map onto min/max/default', () => {
    assert.deepEqual(
        [buildRule(null, { pick: 1 }, 3, 0).rule.min_picks, buildRule(null, { pick: 1 }, 3, 0).rule.max_picks],
        [1, 1]);
    const up = buildRule(null, { upTo: 2 }, 3, 0).rule;
    assert.deepEqual([up.min_picks, up.max_picks, up.default_mode], [1, 2, 'first_n']);
    const all = buildRule(null, { all: true }, 3, 0).rule;
    assert.deepEqual([all.min_picks, all.max_picks, all.default_mode], [null, null, 'all']);
});

test('buildRule: a pick larger than the bonuses attached is refused', () => {
    assert.match(caught(() => buildRule(null, { pick: 4 }, 3, 0)).message, /more than the 3 bonuses/);
    assert.match(caught(() => buildRule(null, { upTo: 1 }, 0, 0)).message, /no bonuses yet/);
    assert.match(caught(() => buildRule(null, { pick: 1, all: true }, 3, 0)).message, /only one of/);
    assert.match(caught(() => buildRule(null, {}, 3, 0)).message, /no bonus rule yet/);
    assert.match(caught(() => buildRule(RULE, { min: 2 }, 3, 0)).message, /more than the maximum/);
});

test('buildRule: fixed gift shipping needs a price; a price alone implies fixed', () => {
    assert.match(caught(() => buildRule(RULE, { giftShipping: 'fixed' }, 3, 1)).message, /needs a price/);
    const r = buildRule(RULE, { giftPrice: 4.99, gift: 'on' }, 3, 1).rule;
    assert.deepEqual([r.gift_shipping_mode, r.gift_shipping_price, r.gift_shipping_enabled], ['fixed', 4.99, true]);
    const back = buildRule(r, { giftShipping: 'free' }, 3, 1).rule;
    assert.deepEqual([back.gift_shipping_mode, back.gift_shipping_price], ['free', null]);
    assert.match(caught(() => buildRule(RULE, { gift: 'maybe' }, 3, 1)).message, /on or off/);
});

test('buildRule: partial edits keep the rest; gift on with nothing giftable warns', () => {
    const { rule, warnings } = buildRule(RULE, { gift: 'on' }, 3, 0);
    assert.equal(rule.max_picks, 1);
    assert.equal(rule.gift_shipping_enabled, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no bonus is giftable/);
});

test('describeRule / bonusSummary read like the rule', () => {
    assert.match(describeRule(RULE, 3), /pick exactly 1 of 3, none picked → first 1 · gift: off/);
    assert.match(describeRule(null, 2), /not active on the internal checkout/);
    assert.equal(bonusSummary({ id: 1, title: null, code: null, bonuses: [{}, {}, {}], bonus_rule: { ...RULE, max_picks: 2, min_picks: 1, gift_shipping_enabled: true } }), '3 (up to 2) +gift');
    assert.equal(bonusSummary({ id: 1, title: null, code: null }), '');
});

// ── checkout_settings.bonuses override ───────────────────────────────

test('override: a valid Herpafend-shaped map is clean', () => {
    const T = [{ code: 'SNOOZE', giftable: true }, { code: 'BIOME', giftable: true }, 'MORINGA'];
    assert.deepEqual(validateBonusOverride({
        MAIN_2B: { options: T, min: 1, max: 1, default: 'first_n', gift_shipping: { enabled: true, mode: 'same_as_main' } },
        MAIN_6B: { options: T, max: null, default: 'all' },
        MAIN_OFF: { options: [] },
    }), []);
});

test('override: shape mistakes are reported', () => {
    const msgs = (v: unknown, bumps?: string[]) => validateBonusOverride(v, { bumps }).map(i => `${i.severity}: ${i.message}`).join('\n');
    assert.match(msgs({ options: ['A'] }), /keyed by the MAIN product code/);
    assert.match(msgs({ M: { options: ['A', 'B'], max: 3 } }), /max 3 is more than the 2 options/);
    assert.match(msgs({ M: { options: ['A', 'B'], min: 2, max: 1 } }), /min \(2\) is more than max \(1\)/);
    assert.match(msgs({ M: { options: ['A,B'] } }), /not a product code — list each code/);
    assert.match(msgs({ M: { options: ['A', 'a'] } }), /listed twice/);
    assert.match(msgs({ M: { options: ['M'] } }), /cannot be its own bonus/);
    assert.match(msgs({ M: { options: ['A'], default: 'none' } }), /default must be/);
    assert.match(msgs({ M: { options: ['A'], gift_shipping: { enabled: true, mode: 'fixed' } } }), /needs a price/);
    assert.match(msgs({ M: { options: [{ code: 'A' }], gift_shipping: { enabled: true } } }), /warning: .*no option is giftable/);
    assert.match(msgs({ M: { options: ['A'] } }, ['a']), /both a bump and a bonus/);
    assert.match(msgs({ M: { options: ['A'], pick: 1 } }), /warning: .*unknown key "pick"/);
});

test('lint: checkout_settings.bonuses in a page backend script is checked', () => {
    const page = [
        '<script scope="backend">',
        'setVariable("checkout_settings", {',
        '  bumps: ["shi", "TREAT_A"],',
        '  bonuses: { MAIN_2B: { options: ["TREAT_A", "TREAT_B"], min: 1, max: 3 } }',
        '});',
        '</script>',
        '<div>hi</div>',
    ].join('\n');
    const issues = lintEfContent(page, { kind: 'page' }).issues.map(i => `${i.severity} L${i.line} ${i.message}`);
    assert.ok(issues.some(i => /error L4 .*max 3 is more than the 2 options/.test(i)), issues.join('\n'));
    assert.ok(issues.some(i => /both a bump and a bonus/.test(i)), issues.join('\n'));
});

test('lint: assignment forms and computed values', () => {
    const js = [
        'var checkout_settings = { collect_tax: false };',
        'checkout_settings.bonuses = { MAIN: { options: ["A"], gift_shipping: { mode: "fixed" } } };',
        'var opts = ["A", "B"];',
        'setVariable("checkout_settings", { bonuses: { MAIN: { options: opts, max: 5 } } });',
    ].join('\n');
    const issues = lintEfContent(js, { kind: 'script' }).issues;
    assert.ok(issues.some(i => /needs a price/.test(i.message) && i.line === 2), JSON.stringify(issues));
    // options is a variable: the count is unknown, so max is not second-guessed.
    assert.ok(!issues.some(i => /max 5/.test(i.message)), JSON.stringify(issues));
});

test('lint: a script without checkout_settings is untouched', () => {
    assert.deepEqual(lintEfContent('var bonuses = { options: [1] };\nsetVariable("x", bonuses);\n', { kind: 'script' }).issues, []);
});

// ── skill ────────────────────────────────────────────────────────────

test('the ef-bonuses-gifts skill ships with the rules agents get wrong', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-skills-bonus-'));
    try {
        const installed = await installBundledSkills(dir);
        assert.ok(installed.includes('ef-bonuses-gifts'), JSON.stringify(installed));
        const body = await fs.promises.readFile(path.join(dir, '.claude', 'skills', 'ef-bonuses-gifts', 'SKILL.md'), 'utf8');
        assert.match(body, /\nname: ef-bonuses-gifts\b/);
        assert.match(body, /not bumps/i);
        assert.match(body, /422/);
        assert.match(body, /OPTIONAL/);
        assert.match(body, /HERPAFEND_MAIN_6B_P294/);
        assert.match(body, /checkout_settings\.bonuses/);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

// ── end to end against a mock product API ───────────────────────────

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface ProductMock {
    url: string;
    posts: Array<Record<string, unknown>>;
    close: () => Promise<void>;
}

function startProductMock(): Promise<ProductMock> {
    const posts: ProductMock['posts'] = [];
    const product: Record<string, unknown> = {
        id: 812, code: 'MAIN_3B', title: 'Three bottles', classification: 'main',
        bonuses: [{ product_id: 5, code: 'TREAT_A', title: 'A', position: 0, quantity: 1, giftable: false }],
        bonus_rule: null,
    };
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                const url = req.url || '';
                res.setHeader('content-type', 'application/json');
                if (req.method === 'GET' && /\/products\/all/.test(url)) { res.end(JSON.stringify([product])); return; }
                if (req.method === 'GET' && /\/products\/812$/.test(url)) { res.end(JSON.stringify({ product })); return; }
                if (req.method === 'POST' && /\/products\/812$/.test(url)) {
                    const body = JSON.parse(raw || '{}');
                    posts.push(body);
                    if (Array.isArray(body.bonuses)) {
                        product.bonuses = body.bonuses.map((b: Record<string, unknown>) => ({ ...b, code: b.code ?? (b.product_id === 5 ? 'TREAT_A' : null) }));
                    }
                    if ('bonus_rule' in body) product.bonus_rule = body.bonus_rule;
                    res.end(JSON.stringify({ product }));
                    return;
                }
                res.statusCode = 404;
                res.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, posts, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function setupBrand(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-bonus-e2e-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'fake-key\n');
    return root;
}

function runEf(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
}

test('ef products bonuses + bonus-rule send the contract fields, by code', async () => {
    const mock = await startProductMock();
    const root = await setupBrand(mock.url);
    try {
        let r = await runEf(root, ['products', 'bonuses', 'main_3b', '--add', 'TREAT_B:giftable', '--giftable', 'TREAT_A', '--json']);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(mock.posts[0], {
            title: 'Three bottles',
            bonuses: [
                { position: 0, quantity: 1, giftable: true, product_id: 5 },
                { position: 1, quantity: 1, giftable: true, code: 'TREAT_B' },
            ],
        });

        // A pick the buyer could never satisfy never reaches the server.
        r = await runEf(root, ['products', 'bonus-rule', '812', '--pick', '3']);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /more than the 2 bonuses/);
        assert.equal(mock.posts.length, 1);

        r = await runEf(root, ['products', 'bonus-rule', '812', '--up-to', '2', '--gift', 'on', '--gift-price', '4.99', '--json']);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(mock.posts[1].bonus_rule, {
            min_picks: 1, max_picks: 2, default_mode: 'first_n',
            gift_shipping_enabled: true, gift_shipping_mode: 'fixed', gift_shipping_price: 4.99,
        });
        assert.equal(mock.posts[1].bonuses, undefined, 'a rule edit leaves the bonus list untouched');

        r = await runEf(root, ['products', 'bonus-rule', '812', '--clear', '--json']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(mock.posts[2].bonus_rule, null);

        r = await runEf(root, ['products', 'list']);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /bonuses/);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
