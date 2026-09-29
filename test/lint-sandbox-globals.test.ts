import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { lintEfContent } from '../src/lint/lintEf';

/**
 * The backend-script sandbox rules exist to catch `X is not defined` before a
 * live request does. They used to scan raw source with a regex, so a comment
 * mentioning localStorage and a field label `'Image URL'` were reported as hard
 * errors — and an error the author can SEE is wrong is worse than no check at
 * all, because it teaches them to stop reading the linter.
 *
 * The pairs below are the point: every false positive has a true positive
 * beside it, so a future "just mask more" fix can't quietly buy silence by
 * retiring the rule.
 */

function issuesFor(js: string): string[] {
    return lintEfContent(js, { kind: 'script' }).issues.map((i) => `${i.severity} L${i.line} ${i.message}`);
}

function assertClean(js: string, why: string): void {
    const found = issuesFor(js);
    assert.deepEqual(found, [], `${why}\n  got: ${found.join('\n       ')}`);
}

function assertReports(js: string, needle: RegExp, why: string): void {
    const found = issuesFor(js);
    assert.ok(found.some((i) => needle.test(i)), `${why}\n  got: ${found.join('\n       ') || '(nothing)'}`);
}

// ── Prose is not code ────────────────────────────────────────────────

test('a comment mentioning a missing global is not a reference to it', () => {
    assertClean(
        '// Items are stored client-side in localStorage; the server mirrors them.\nexport function run() { return 1; }\n',
        'a line comment is prose',
    );
    assertClean(
        '/* Build a public share URL for the referral. */\nexport function run() { return 1; }\n',
        'a block comment is prose',
    );
});

test('a string literal that happens to contain a global name is not a reference', () => {
    assertClean(
        "export const fields = [{ type: 'alert', label: 'Image URL' }, { label: 'Link URL' }];\n",
        'string values are data, not identifiers',
    );
    assertClean(
        'const heading = `see the Image URL field below`;\n',
        'template literal TEXT is data too',
    );
});

test('a name the script declares for itself shadows the global', () => {
    assertClean(
        'const fetch = makeClient();\nexport function run() { return fetch("/x"); }\n',
        'a local binding is used everywhere in the file, not just where it is declared',
    );
    assertClean(
        'function alert(msg) { return msg; }\nexport function run() { return alert("hi"); }\n',
        'a local function declaration shadows too',
    );
});

/** `typeof X` is the one expression that provably cannot throw "X is not defined". */
test('a typeof guard is not a reference that can fail', () => {
    assertClean(
        'export function run() { return typeof URL === "undefined" ? "no" : "yes"; }\n',
        'feature detection is the correct way to ask, not a bug',
    );
});

test('a property with a global\'s name is not the global', () => {
    assertClean(
        'export function run() { return opts.fetch + opts.crypto; }\n',
        'obj.fetch is a property read',
    );
    assertClean(
        "export const handlers = { alert: 1, window: 2, document: 3 };\n",
        'object keys are not identifiers',
    );
});

// ── …and the rules still fire on real code ───────────────────────────

test('a real bare reference is still a hard error', () => {
    assertReports('export function run() { return fetch("/x"); }\n', /error .*"fetch" does not exist/, 'bare call');
    assertReports('export function run() { return new URL("https://x"); }\n', /error .*"URL" does not exist/, 'constructor');
    assertReports('export function run() { return window.location.href; }\n', /error .*"window" does not exist/, 'member root');
});

/**
 * Both of these were silently lost by an earlier masking attempt: blanking
 * string CONTENTS killed the import-specifier half of the Node/fs rule, and a
 * regex literal containing an apostrophe desynced the scanner so everything
 * after it went unchecked.
 */
test('an import specifier is a string the Node/fs rule is meant to read', () => {
    assertReports('import fs from "fs";\nexport function run() { return fs; }\n', /warning .*Node\/filesystem API/, 'from "fs"');
    assertReports('import "node:path";\n', /warning .*Node\/filesystem API/, 'bare side-effect import');
});

test('a regex literal does not blind the rest of the file', () => {
    assertReports(
        "const apostrophe = /don't/;\nexport function run() { return URLSearchParams; }\n",
        /error .*"URLSearchParams" does not exist/,
        'a quote inside a regex must not swallow the code after it',
    );
});

test('an interpolated expression inside a template literal is real code', () => {
    assertReports(
        'export const s = `v=${localStorage.get("k")}`;\n',
        /error .*"localStorage" does not exist/,
        '${…} is evaluated, unlike the literal text around it',
    );
});

test('template syntax in JS is still reported, but not from a comment', () => {
    assertReports('export function run() { return "{{ name }}"; }\n', /error .*Template syntax/, 'in code');
    assertClean('// the template does {{ name }} for us\nexport function run() { return 1; }\n', 'in a comment');
});

test('a script that does not parse still reports the syntax error', () => {
    assertReports('const x = ;\n', /error .*does not parse/, 'the parse check is independent of the token scan');
});

// ── The page shape that reported the false positives ─────────────────

test('a backend block full of prose lints clean, and the frontend block is untouched', () => {
    const page = [
        '{{-- efmeta:{"v":1,"type":"page","id":1,"slug":"wishlist"} --}}',
        '<h1>Wishlist</h1>',
        '<script scope="backend">',
        '  // Items are stored client-side in localStorage; the server only mirrors them.',
        '  // Build a public share URL from the referral code.',
        "  const fields = [{ type: 'alert', label: 'Image URL' }, { type: 'text', label: 'Link URL' }];",
        '  setVariable("fields", fields);',
        '</script>',
        '<script>',
        '  // A FRONTEND script. localStorage is correct here, and was never in',
        '  // scope for these rules — only backend-scoped blocks are.',
        '  localStorage.setItem("wishlist", "[]");',
        '</script>',
    ].join('\n');
    const res = lintEfContent(page, { kind: 'page' });
    assert.deepEqual(res.issues, [], `expected a clean page, got ${JSON.stringify(res.issues, null, 2)}`);
    assert.equal(res.ok, true);
});

test('a backend block with a real missing global is still caught inside a page', () => {
    const page = [
        '{{-- efmeta:{"v":1,"type":"page","id":2,"slug":"referrals"} --}}',
        '<script scope="backend">',
        '  const qs = new URLSearchParams(request.query);',
        '</script>',
    ].join('\n');
    const res = lintEfContent(page, { kind: 'page' });
    assert.equal(res.ok, false);
    const hit = res.issues.find((i) => /URLSearchParams/.test(i.message));
    assert.ok(hit, 'the real error must survive');
    assert.equal(hit?.line, 3, 'reported at the line inside the page, not inside the extracted block');
});
