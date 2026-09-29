import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    autoColor,
    collectTag,
    colorLabel,
    findTag,
    parseTargetRef,
    resolveColor,
    shellQuote,
} from '../src/commands/tags';
import { BrandTag, TAG_AUTO_COLORS, TAG_COLORS } from '../src/models/tag';
import { CliError, ExitCode } from '../src/utils/exit';

/**
 * Tags are cheap to get subtly wrong and expensive to notice: a mis-parsed
 * target writes a join row against the wrong record id, and a mis-parsed colour
 * either fails server validation or stores a string the dashboard renders as a
 * different shade than the picker would. Both are silent from the CLI's side,
 * so the parsing is unit-tested rather than trusted.
 */

function caught(fn: () => unknown): CliError {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof CliError, `expected a CliError, got ${err}`);
        return err;
    }
    throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' });
}

// ── Target parsing ───────────────────────────────────────────────────

test('a bare reference is a page — the common case needs no prefix', () => {
    assert.deepEqual(parseTargetRef('pricing'), { kind: 'page', ref: 'pricing' });
    assert.deepEqual(parseTargetRef('  8878 '), { kind: 'page', ref: '8878' });
});

test('the component prefix and its aliases select components', () => {
    for (const prefix of ['component', 'components', 'comp', 'COMPONENT']) {
        assert.deepEqual(parseTargetRef(`${prefix}:hero-banner`), { kind: 'component', ref: 'hero-banner' });
    }
});

test('an explicit page prefix is accepted too', () => {
    assert.deepEqual(parseTargetRef('page:pricing'), { kind: 'page', ref: 'pricing' });
});

/**
 * Nested and wildcard slugs are ordinary page references. Treating an unknown
 * prefix as part of the slug is what keeps these working without escaping.
 */
test('slugs that contain punctuation stay whole page references', () => {
    assert.deepEqual(parseTargetRef('shop/product/{code}'), { kind: 'page', ref: 'shop/product/{code}' });
    assert.deepEqual(parseTargetRef('weird:slug'), { kind: 'page', ref: 'weird:slug' });
});

test('an empty target, or a prefix with nothing after it, is a usage error', () => {
    assert.equal(caught(() => parseTargetRef('')).code, ExitCode.Validation);
    assert.equal(caught(() => parseTargetRef('   ')).code, ExitCode.Validation);
    assert.equal(caught(() => parseTargetRef('component:')).code, ExitCode.Validation);
});

// ── Colours ──────────────────────────────────────────────────────────

test('swatch names resolve to the exact values the dashboard picker writes', () => {
    assert.equal(resolveColor('blue'), 'rgb(219,234,254)');
    assert.equal(resolveColor('CORAL'), TAG_COLORS.coral);
    assert.equal(resolveColor('  green  '), TAG_COLORS.green);
});

test('hex is accepted and lower-cased', () => {
    assert.equal(resolveColor('#AABBCC'), '#aabbcc');
    assert.equal(resolveColor('#abc'), '#abc');
});

/** Squeezing the whitespace is what stops a CLI tag and an app tag differing. */
test('rgb() is normalised to the app\'s spacing-free form', () => {
    assert.equal(resolveColor('rgb( 12 ,34,  56 )'), 'rgb(12,34,56)');
    assert.equal(resolveColor('RGB(0,0,0)'), 'rgb(0,0,0)');
});

test('out-of-range channels and junk are rejected, and the error lists the names', () => {
    assert.equal(caught(() => resolveColor('rgb(300,0,0)')).code, ExitCode.Validation);
    const err = caught(() => resolveColor('chartreuse'));
    assert.equal(err.code, ExitCode.Validation);
    assert.match(err.message, /coral/, 'names the swatches so the fix is obvious');
    assert.match(err.message, /"chartreuse"/, 'quotes what was actually passed');
    assert.equal(caught(() => resolveColor('#ggg')).code, ExitCode.Validation);
    assert.equal(caught(() => resolveColor('')).code, ExitCode.Validation);
});

test('an auto colour is stable per name, and never the loud swatches', () => {
    assert.equal(autoColor('black-friday'), autoColor('  Black-Friday  '));
    const spread = new Set(['launch', 'q4', 'quiz', 'upsell', 'seo', 'archive'].map(autoColor));
    assert.ok(spread.size > 1, 'a batch of tags must not all come out the same colour');
    for (const name of ['launch', 'q4', 'quiz', 'upsell', 'seo', 'archive']) {
        assert.ok(TAG_AUTO_COLORS.includes(autoColor(name)), `${name} picked a colour outside the soft palette`);
        assert.notEqual(autoColor(name), TAG_COLORS.coral);
        assert.notEqual(autoColor(name), TAG_COLORS.black);
    }
});

test('colorLabel names a swatch and passes anything else through', () => {
    assert.equal(colorLabel(TAG_COLORS.blue), 'blue (rgb(219,234,254))');
    assert.equal(colorLabel('#123456'), '#123456');
    assert.equal(colorLabel(null), '');
});

// ── Tag lookup ───────────────────────────────────────────────────────

const TAGS: BrandTag[] = [
    { id: 1, name: 'Black Friday', color: TAG_COLORS.coral },
    { id: 2, name: 'q4', color: TAG_COLORS.blue },
    { id: 3, name: 'Q4', color: TAG_COLORS.green },
];

test('lookup is by numeric id first, then case-insensitive name', () => {
    assert.equal(findTag(TAGS, '1')?.id, 1);
    assert.equal(findTag(TAGS, 'black friday')?.id, 1);
    assert.equal(findTag(TAGS, 'BLACK FRIDAY')?.id, 1);
    assert.equal(findTag(TAGS, 'nope'), null);
});

/**
 * Names are not unique server-side. Picking one silently would attach a tag
 * with the wrong colour, which nobody would notice until they looked at the
 * dashboard — so it has to be a hard error naming both candidates.
 */
test('an ambiguous name is refused rather than guessed', () => {
    const err = caught(() => findTag(TAGS, 'q4'));
    assert.equal(err.code, ExitCode.Validation);
    assert.match(err.message, /#2, #3/);
});

test('an id lookup still works when the name is ambiguous', () => {
    assert.equal(findTag(TAGS, '2')?.color, TAG_COLORS.blue);
});

// ── --tag collection ─────────────────────────────────────────────────

test('--tag accumulates, splits commas, and drops blanks', () => {
    let acc: string[] = [];
    acc = collectTag('launch', acc);
    acc = collectTag('q4, black-friday', acc);
    acc = collectTag('  ', acc);
    assert.deepEqual(acc, ['launch', 'q4', 'black-friday']);
});

// ── Suggested commands ───────────────────────────────────────────────

/**
 * The "create it with …" hint is meant to be pasted. A name wrapped in double
 * quotes inside an already double-quoted suggestion isn't runnable, so simple
 * names stay bare and anything else gets shell — not JSON — quoting.
 */
test('a suggested command quotes only what a shell needs quoted', () => {
    assert.equal(shellQuote('black-friday'), 'black-friday');
    assert.equal(shellQuote('q4/launch'), 'q4/launch');
    assert.equal(shellQuote('Black Friday'), "'Black Friday'");
    assert.equal(shellQuote("it's live"), "'it'\\''s live'");
});
