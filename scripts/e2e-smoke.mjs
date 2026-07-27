#!/usr/bin/env node
// End-to-end smoke test against a REAL, already-bound ElasticFunnels project.
//
// Unlike the unit suite (which uses an in-process mock server), this exercises
// the LOCAL build of the CLI against the live backend to catch payload/endpoint
// mismatches the mock can't. It only touches throwaway, uniquely-named entities
// and cleans them up in a finally block.
//
// Usage:
//   node scripts/e2e-smoke.mjs [projectDir]
//   EF_PROJECT=/path/to/bound/project node scripts/e2e-smoke.mjs
//   EF_BIN=/path/to/ef.js node scripts/e2e-smoke.mjs        # override the CLI under test
//
// Exit 0 = all checks passed; non-zero = at least one failed.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.EF_BIN || path.resolve(HERE, '..', 'bin', 'ef.js');
const PROJECT = path.resolve(process.env.EF_PROJECT || process.argv[2] || process.cwd());
const STAMP = `${Date.now()}`;
const TAG = `clitest-${STAMP}`;

if (!fs.existsSync(path.join(PROJECT, '.ef', 'config.json'))) {
    console.error(`✗ ${PROJECT} is not a bound project (no .ef/config.json). Run "ef init" there first.`);
    process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT, '.ef', 'config.json'), 'utf8'));
const syncRoot = cfg.syncRoot || 'elasticfunnels';
const brandRoot = cfg.syncLayout === 'nested' ? path.join(PROJECT, syncRoot, String(cfg.brandId)) : path.join(PROJECT, syncRoot);

/** Run the CLI under test from the project dir. */
function ef(args, { input } = {}) {
    const r = spawnSync(process.execPath, [BIN, ...args], {
        cwd: PROJECT, encoding: 'utf8', input,
        env: { ...process.env, NO_COLOR: '1' },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
/** Blocking sleep (no async in this simple sequential harness). */
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** Retry an IDEMPOTENT command through transient network/ES blips. NEVER use for POST creates. */
function efOk(args, tries = 3) {
    let r;
    for (let i = 0; i < tries; i++) { r = ef(args); if (r.status === 0) return r; sleep(400); }
    return r;
}
function json(res) { try { return JSON.parse(res.stdout); } catch { return null; } }

const results = [];
const cleanups = [];
function check(name, fn) {
    try {
        fn();
        results.push({ name, ok: true });
        console.log(`  ✓ ${name}`);
    } catch (err) {
        results.push({ name, ok: false, err: err.message });
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// Identity-based cleanup: resolve by code/slug via list so an ambiguous POST
// (network reset AFTER the server created the row) still gets cleaned up, and
// an already-deleted entity (NotFound) is treated as success.
function deleteProductByCode(code) {
    const list = json(ef(['products', 'list', '--json']));
    if (Array.isArray(list)) for (const p of list.filter((x) => x.code === code)) ef(['products', 'delete', String(p.id), '--force']);
    return { status: 0 };
}
function deletePageBySlug(slug) {
    const r = ef(['pages', 'delete', slug, '--force']);
    return { status: r.status === 7 ? 0 : r.status }; // 7 = NotFound = already gone
}
function deleteCrmEntityBySlug(slug) {
    const list = json(ef(['crm', 'entities', '--json']));
    if (Array.isArray(list)) for (const e of list.filter((x) => x.slug === slug)) ef(['crm', 'entities', 'delete', String(e.id), '--force']);
    return { status: 0 };
}

console.log(`ef e2e smoke — bin=${BIN}\n              project=${PROJECT} (brand #${cfg.brandId})\n`);

// ── Read-only / connectivity ──────────────────────────────────────────
check('whoami --json reaches the brand', () => {
    const r = ef(['whoami', '--json']);
    eq(r.status, 0, `exit code; stderr=${r.stderr}`);
    assert(r.stdout.includes(String(cfg.brandId)), 'whoami output mentions the brand id');
});

check('status connects', () => {
    const r = ef(['status']);
    eq(r.status, 0, `exit code; stderr=${r.stderr}`);
});

check('list pages --json returns an array', () => {
    const r = ef(['list', 'pages', '--json']);
    eq(r.status, 0, `exit code; stderr=${r.stderr}`);
    assert(Array.isArray(json(r)), 'output is a JSON array');
});

check('diff runs clean on an untouched tree', () => {
    const r = ef(['diff']);
    eq(r.status, 0, `exit code; stderr=${r.stderr}`);
});

// ── variables get / set (live round-trip) ─────────────────────────────
check('variables set → get round-trips a namespaced value', () => {
    const key = `_clitest.smoke`;
    const val = `smoke-${STAMP}`;
    cleanups.push(['variables cleanup', () => ef(['variables', 'set', '_clitest', '{}'])]);
    const set = ef(['variables', 'set', key, val]);
    eq(set.status, 0, `set exit; stderr=${set.stderr}`);
    const got = json(ef(['variables', 'get']));
    assert(got && got._clitest && got._clitest.smoke === val, `variables get shows ${key}=${val}`);
});

// ── lint (offline, temp files under pages/) ───────────────────────────
check('lint flags a broken page (exit 2) and passes a good one (exit 0)', () => {
    fs.mkdirSync(path.join(brandRoot, 'pages'), { recursive: true });
    const bad = path.join(brandRoot, 'pages', `${TAG}-bad.ef`);
    const good = path.join(brandRoot, 'pages', `${TAG}-good.ef`);
    cleanups.push(['rm lint temp files', () => { fs.rmSync(bad, { force: true }); fs.rmSync(good, { force: true }); }]);
    fs.writeFileSync(bad, '@if(x)\n  {{ name\n@foreach(items)\n<p>@bogus(y)</p>\n');
    fs.writeFileSync(good, '<h1>ok</h1>\n@if(user.active)\n<p>hi</p>\n@endif\n');
    eq(ef(['lint', `pages/${TAG}-bad.ef`]).status, 2, 'broken page → exit 2');
    eq(ef(['lint', `pages/${TAG}-good.ef`]).status, 0, 'good page → exit 0');
});

// ── pages create → pull → push → delete (full loop on the live server) ─
const pageSlug = `${TAG}-page`;
cleanups.push(['delete test page', () => deletePageBySlug(pageSlug)]);
check('pages create makes a page on the server', () => {
    const r = ef(['pages', 'create', pageSlug, '--json']);
    eq(r.status, 0, `exit; stderr=${r.stderr}`);
});

check('pull page → edit → push round-trips against the server', () => {
    assert(pageSlug, 'page was created');
    const pull = ef(['pull', 'page', pageSlug]);
    eq(pull.status, 0, `pull exit; stderr=${pull.stderr}`);
    // Find the pulled file and append a harmless edit below the efmeta line.
    const rel = path.join(brandRoot, 'pages', `${pageSlug}.ef`);
    assert(fs.existsSync(rel), `pulled file exists at ${rel}`);
    const content = fs.readFileSync(rel, 'utf8');
    assert(/efmeta:/.test(content.split('\n')[0]), 'pulled file carries an efmeta identity line');
    fs.writeFileSync(rel, `${content.replace(/\s*$/, '')}\n<p>smoke ${STAMP}</p>\n`);
    const push = ef(['push', `pages/${pageSlug}.ef`]);
    eq(push.status, 0, `push exit; stderr=${push.stderr}`);
});

// ── products create → delete ──────────────────────────────────────────
const productCode = `${TAG}-prod`;
cleanups.push(['delete test product', () => deleteProductByCode(productCode)]);
check('products create → list → delete', () => {
    const create = ef(['products', 'create', '--code', productCode, '--title', 'CLI Smoke Test', '--price', '1', '--type', 'digital', '--json']);
    eq(create.status, 0, `create exit; stderr=${create.stderr}`);
    const body = json(create);
    assert(body?.product?.id ?? body?.id, `created product id present (got ${JSON.stringify(body)})`);
    const list = json(ef(['products', 'list', '--json']));
    assert(Array.isArray(list) && list.some((p) => p.code === productCode), 'new product appears in list');
});

// ── domains (read-only) ───────────────────────────────────────────────
check('domains list runs', () => {
    const r = ef(['domains', 'list', '--json']);
    eq(r.status, 0, `exit; stderr=${r.stderr}`);
});

// ── crm: entity → pipeline → stage → field → entry (full CRUD, live ES) ─
const crmSlug = `${TAG}-crm`;
cleanups.push(['delete test crm entity', () => deleteCrmEntityBySlug(crmSlug)]);
let crmEntityId = null;
let crmPipelineId = null;
let crmStageId = null;
check('crm create: entity → pipeline → stage → field', () => {
    const e = json(ef(['crm', 'entities', 'create', '--name', `CLI ${STAMP}`, '--slug', crmSlug, '--entity-mode', 'crm', '--json']));
    crmEntityId = e?.entity?.id;
    assert(crmEntityId, `entity id present (got ${JSON.stringify(e)})`);
    const p = json(ef(['crm', 'pipelines', 'create', String(crmEntityId), '--name', 'Sales', '--json']));
    crmPipelineId = p?.pipeline?.id;
    assert(crmPipelineId, `pipeline id present (got ${JSON.stringify(p)})`);
    const s = json(ef(['crm', 'stages', 'create', String(crmPipelineId), '--name', 'New', '--order', '0', '--probability', '100', '--json']));
    crmStageId = s?.stage?.id;
    assert(crmStageId, `stage id present (got ${JSON.stringify(s)})`);
    const f = json(ef(['crm', 'fields', 'create', String(crmEntityId), '--label', 'Budget', '--key', 'budget', '--type', 'number', '--json']));
    assert(f?.field?.id, `field id present (got ${JSON.stringify(f)})`);
});

check('crm entry: create → get → move (Elasticsearch)', () => {
    assert(crmEntityId && crmPipelineId && crmStageId, 'prereqs created');
    const en = json(ef(['crm', 'entries', 'create', String(crmEntityId), '--title', 'Jane Smoke', '--pipeline', String(crmPipelineId), '--stage', String(crmStageId), '--values', '{"budget":5000}', '--json']));
    const entryId = en?.entry?.id;
    assert(entryId, `entry id present (got ${JSON.stringify(en)})`);
    cleanups.push(['delete test crm entry', () => ef(['crm', 'entries', 'delete', String(entryId), '--force'])]);
    // GET/move by ES _id are idempotent → retry through transient blips.
    eq(efOk(['crm', 'entries', 'get', String(entryId)]).status, 0, 'entry get by id');
    eq(efOk(['crm', 'entries', 'move', String(entryId), '--stage', String(crmStageId), '--json']).status, 0, 'entry move');
});

// ── cleanup ───────────────────────────────────────────────────────────
console.log('\ncleanup:');
for (const [name, fn] of cleanups.reverse()) {
    try { const r = fn(); console.log(`  · ${name}${r && r.status !== 0 ? ` (exit ${r.status})` : ''}`); }
    catch (err) { console.log(`  · ${name} — FAILED: ${err.message}`); }
}

// ── summary ───────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
}
console.log('✓ all smoke checks passed');
