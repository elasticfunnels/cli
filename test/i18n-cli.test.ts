import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { parseEfMeta, serializeEfMeta, withEfMeta } from '../src/sync/efMeta';
import { applyI18nToMeta, i18nChanges, i18nFromMeta, parseLangFlag } from '../src/sync/pageI18n';
import { buildReport, dictionaryFileFor, parseDictionaryFile } from '../src/commands/i18n';
import { normalizeLanguageCode } from '../src/api/i18nApi';
import { translationSourceHash } from '../src/utils/textHash';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

// ── Units ────────────────────────────────────────────────────────────

test('efmeta: language and translation_of are written, empty ones are not', () => {
    const line = serializeEfMeta({ v: 1, type: 'page', brandId: 7, id: 42, slug: 'ro/despre', path: 'pages/ro/despre.ef', language: 'ro', translation_of: 'about' });
    assert.match(line, /"language":"ro"/);
    assert.match(line, /"translation_of":"about"/);
    const bare = serializeEfMeta(applyI18nToMeta({ v: 1, type: 'page', brandId: 7, id: 42, language: 'ro' }, { language: null, translation_of: null }));
    assert.doesNotMatch(bare, /language|translation_of/);
});

test('i18nChanges: only the fields that differ from the baseline', () => {
    assert.deepEqual(i18nChanges({ language: 'ro', translation_of: 'about' }, { language: 'ro', translation_of: 'about' }), {});
    assert.deepEqual(i18nChanges({ language: 'es', translation_of: 'about' }, { language: 'ro', translation_of: 'about' }), { language: 'es' });
    assert.deepEqual(i18nChanges(i18nFromMeta({ v: 1, type: 'page', brandId: 1, id: 1 }), { language: 'ro', translation_of: 'about' }), { language: null, translation_of: null });
});

test('parseLangFlag and normalizeLanguageCode follow the app normalization', () => {
    assert.equal(parseLangFlag('PT-BR'), 'pt-br');
    assert.equal(parseLangFlag('none'), null);
    assert.throws(() => parseLangFlag('12'));
    assert.equal(normalizeLanguageCode(' Pt_BR '), 'ptbr');
});

test('buildReport: missing, stale, stale after push; a source without a language stands for the default', () => {
    const srcHtmlHash = translationSourceHash({ seo_title: '', seo_description: '', html: '<h1>Old</h1>' });
    const rows = [
        { id: 1, ref: 'about', language: null, sourceId: null, stale: null, sourceHash: null },
        { id: 2, ref: 'ro/about', language: 'ro', sourceId: 1, stale: true, sourceHash: 'x' },
        { id: 3, ref: 'es/about', language: 'es', sourceId: 1, stale: false, sourceHash: srcHtmlHash },
        { id: 4, ref: 'checkout', language: null, sourceId: null, stale: null, sourceHash: null },
    ];
    const report = buildReport('page', rows, ['en', 'ro', 'es', 'pt-br'], 'en', (id) => id === 1 ? translationSourceHash({ html: '<h1>New</h1>' }) : null);
    assert.equal(report.length, 1, 'a page with no language and no translations is not a group');
    assert.deepEqual(report[0].missing, ['pt-br']);
    assert.deepEqual(report[0].stale.map(s => s.id), [2]);
    assert.deepEqual(report[0].staleAfterPush.map(s => s.id), [3]);
    assert.deepEqual(report[0].languages.map(l => l.language).sort(), ['en', 'es', 'ro']);
});

test('buildReport: a tagged page with no translation is skipped unless includeUntranslated (partly translated sites)', () => {
    const rows = [
        { id: 10, ref: 'features', language: 'en', sourceId: null, stale: null, sourceHash: null },
        { id: 11, ref: 'faq', language: 'en', sourceId: null, stale: null, sourceHash: null },
        { id: 12, ref: 'ro/faq', language: 'ro', sourceId: 11, stale: false, sourceHash: null },
    ];
    const report = buildReport('page', rows, ['en', 'ro', 'es'], 'en', () => null);
    assert.deepEqual(report.map(g => g.source.ref), ['faq'], 'features has no translation, so it is not a gap');
    assert.deepEqual(report[0].missing, ['es']);
    const all = buildReport('page', rows, ['en', 'ro', 'es'], 'en', () => null, { includeUntranslated: true });
    assert.deepEqual(all.map(g => g.source.ref), ['faq', 'features']);
    assert.deepEqual(all[1].missing, ['ro', 'es']);
});

test('dictionary file: round trip and validation', () => {
    const file = dictionaryFileFor({ id: 3, code: 'ro', label: 'Română', is_default: false, sort_order: 1, url_prefix: null },
        [{ key: 'b', value: 'B' }, { key: 'a', value: null }]);
    assert.deepEqual(Object.keys(file.entries), ['a', 'b']);
    const back = parseDictionaryFile(JSON.stringify(file), 'translations/ro.json');
    assert.equal(back.language.code, 'ro');
    assert.equal(back.entries.a, '');
    assert.throws(() => parseDictionaryFile('{"language":{"code":"ro","url_prefix":"ro/x"},"entries":{}}', 'ro.json'), /url_prefix/);
    assert.throws(() => parseDictionaryFile('{"language":{"code":"ro"},"entries":{"a":1}}', 'ro.json'), /must be a string/);
});

// ── Commands against a mock server ───────────────────────────────────

interface Req { method: string; url: string; body: Record<string, unknown> }
interface Mock { url: string; reqs: Req[]; close: () => Promise<void> }
type Handler = (req: Req) => unknown;

function startMock(routes: Array<[string, RegExp, Handler]>): Promise<Mock> {
    const reqs: Req[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                let body: Record<string, unknown> = {};
                try { body = JSON.parse(raw || '{}'); } catch { /* {} */ }
                const r: Req = { method: req.method || 'GET', url: req.url || '', body };
                reqs.push(r);
                const hit = routes.find(([m, re]) => m === r.method && re.test(r.url.split('?')[0]));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(hit ? hit[2](r) : {}));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, reqs, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

async function setupProject(apiUrl: string): Promise<{ root: string; brandRoot: string }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-i18n-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
    return { root, brandRoot };
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

const PAGES = [
    { id: 10, slug: 'about', title: 'About', parent_page_id: null, is_active_version: true, language: 'en', translation_source_id: null, translation_stale: null },
    { id: 42, slug: 'ro/despre', title: 'Despre', parent_page_id: null, is_active_version: true, language: 'ro', translation_source_id: 10, translation_stale: true },
];

function pageRoutes(language: { current: string }): Array<[string, RegExp, Handler]> {
    return [
        ['GET', /\/pages\/all$/, () => PAGES],
        ['GET', /\/pages\/42\/editor$/, () => ({ id: 42, slug: 'ro/despre', title: 'Despre', html: '<h1>Despre</h1>', revision_id: null, updated_at: '2026-10-31T10:00:00Z', language: language.current, translation_source_id: 10 })],
        ['POST', /\/pages\/42\/editor$/, () => ({ success: true })],
        ['PUT', /\/pages\/42$/, (r) => { if (typeof r.body.language === 'string') language.current = r.body.language; return { id: 42, slug: 'ro/despre', title: 'Despre', language: language.current }; }],
        ['GET', /\/components\/all$/, () => [{ id: 5, code: 'header', name: 'Header', language: null, translation_source_id: null }]],
        ['GET', /\/components\/5\/editor$/, () => ({ id: 5, code: 'header', name: 'Header', html: '<nav></nav>' })],
        // The app's 201 bodies (PageTranslationsController::storeTranslation, ComponentTranslationsController::store).
        ['POST', /\/components\/5\/translations$/, (r) => ({ component_id: 6, code: 'header-ro', language: r.body.language, translation_source_id: 5, data: [] })],
        ['POST', /\/pages\/10\/translations$/, (r) => ({ page_id: 43, slug: `${String(r.body.language)}/about`, language: r.body.language, translation_source_id: 10, data: [{ id: 43, slug: `${String(r.body.language)}/about`, title: 'Despre', language: r.body.language, is_source: false, stale: false }] })],
        ['POST', /\/pages\/42\/translations\/synced$/, () => ({ success: true })],
        ['GET', /\/translation-languages$/, () => ({ data: [{ id: 1, code: 'en', label: 'English', is_default: true, sort_order: 0 }, { id: 2, code: 'ro', label: 'Română', is_default: false, sort_order: 1 }], current_page: 1, last_page: 1 })],
    ];
}

test('pull writes language + translation_of; push sends only an edited language', async () => {
    const lang = { current: 'ro' };
    const mock = await startMock(pageRoutes(lang));
    const { root, brandRoot } = await setupProject(mock.url);
    try {
        const pull = await runEf(root, ['pull', 'page', 'ro/despre', '--json']);
        assert.equal(pull.status, 0, pull.stderr);
        const file = path.join(brandRoot, 'pages', 'ro', 'despre.ef');
        const { meta, body } = parseEfMeta(await fs.promises.readFile(file, 'utf8'));
        assert.equal(meta?.language, 'ro');
        assert.equal(meta?.translation_of, 'about');
        const state = JSON.parse(await fs.promises.readFile(path.join(brandRoot, '.ef-state.json'), 'utf8'));
        assert.deepEqual(state.pages['pages/ro/despre.ef'].extra.i18n, { language: 'ro', translation_of: 'about' });

        // No language edit: push sends the HTML only.
        let push = await runEf(root, ['push', 'pages/ro/despre.ef', '--json']);
        assert.equal(push.status, 0, push.stderr);
        assert.equal(mock.reqs.filter(r => r.method === 'PUT').length, 0);

        // Edit the efmeta language: push sends it with the title the server requires.
        await fs.promises.writeFile(file, withEfMeta({ ...meta!, language: 'es' }, body));
        push = await runEf(root, ['push', 'pages/ro/despre.ef', '--json']);
        assert.equal(push.status, 0, push.stderr);
        const puts = mock.reqs.filter(r => r.method === 'PUT');
        assert.equal(puts.length, 1);
        assert.deepEqual(puts[0].body, { title: 'Despre', language: 'es' });
        const after = JSON.parse(await fs.promises.readFile(path.join(brandRoot, '.ef-state.json'), 'utf8'));
        assert.equal(after.pages['pages/ro/despre.ef'].extra.i18n.language, 'es');

        // Unlink via translation_of removal.
        const now = parseEfMeta(await fs.promises.readFile(file, 'utf8'));
        const unlinked = { ...now.meta! };
        delete unlinked.translation_of;
        await fs.promises.writeFile(file, withEfMeta(unlinked, now.body));
        push = await runEf(root, ['push', 'pages/ro/despre.ef', '--json']);
        assert.equal(push.status, 0, push.stderr);
        const last = mock.reqs.filter(r => r.method === 'PUT').pop()!;
        assert.deepEqual(last.body, { title: 'Despre', translation_source_id: null });
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pages settings --lang/--translation-of sends ids and rewrites the local efmeta', async () => {
    const lang = { current: 'ro' };
    const mock = await startMock(pageRoutes(lang));
    const { root, brandRoot } = await setupProject(mock.url);
    try {
        assert.equal((await runEf(root, ['pull', 'page', 'ro/despre'])).status, 0);
        const res = await runEf(root, ['pages', 'settings', 'ro/despre', '--lang', 'ES', '--translation-of', 'about', '--json']);
        assert.equal(res.status, 0, res.stderr);
        const put = mock.reqs.filter(r => r.method === 'PUT').pop()!;
        assert.equal(put.body.language, 'es');
        assert.equal(put.body.translation_source_id, 10);
        const { meta } = parseEfMeta(await fs.promises.readFile(path.join(brandRoot, 'pages', 'ro', 'despre.ef'), 'utf8'));
        assert.equal(meta?.language, 'es');
        // And a push afterwards has nothing language-related to send.
        const before = mock.reqs.filter(r => r.method === 'PUT').length;
        assert.equal((await runEf(root, ['push', 'pages/ro/despre.ef'])).status, 0);
        assert.equal(mock.reqs.filter(r => r.method === 'PUT').length, before);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pages create --translation-of without --lang is refused before anything is created', async () => {
    const mock = await startMock(pageRoutes({ current: 'ro' }));
    const { root } = await setupProject(mock.url);
    try {
        const res = await runEf(root, ['pages', 'create', 'ro/x', '--translation-of', 'about']);
        assert.equal(res.status, 2);
        assert.equal(mock.reqs.filter(r => r.method === 'POST').length, 0);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pages translate and components translate POST the translations route', async () => {
    const mock = await startMock(pageRoutes({ current: 'ro' }));
    const { root } = await setupProject(mock.url);
    try {
        let res = await runEf(root, ['pages', 'translate', 'about', '--lang', 'ro', '--title', 'Despre', '--no-pull', '--json']);
        assert.equal(res.status, 0, res.stderr);
        const post = mock.reqs.find(r => r.method === 'POST' && /\/pages\/10\/translations$/.test(r.url))!;
        assert.deepEqual(post.body, { language: 'ro', title: 'Despre' });
        assert.equal(JSON.parse(res.stdout).translation.id, 43);

        res = await runEf(root, ['components', 'translate', 'header', '--lang', 'ro', '--no-copy', '--no-pull', '--json']);
        assert.equal(res.status, 0, res.stderr);
        const cpost = mock.reqs.find(r => r.method === 'POST' && /\/components\/5\/translations$/.test(r.url))!;
        assert.deepEqual(cpost.body, { language: 'ro', copy_content: false });
        assert.equal(JSON.parse(res.stdout).translation.code, 'header-ro');

        res = await runEf(root, ['pages', 'translate', 'about']);
        assert.equal(res.status, 2, 'missing --lang is a usage error');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('i18n check exits 1 on a stale translation and reports missing languages', async () => {
    const mock = await startMock(pageRoutes({ current: 'ro' }));
    const { root } = await setupProject(mock.url);
    try {
        const res = await runEf(root, ['i18n', 'check', '--json']);
        assert.equal(res.status, 1, res.stderr);
        const out = JSON.parse(res.stdout);
        assert.equal(out.summary.stale, 1);
        assert.equal(out.groups[0].source.ref, 'about');
        assert.deepEqual(out.groups[0].missing, []);
        const es = await runEf(root, ['i18n', 'check', '--lang', 'es', '--pages', '--json']);
        assert.deepEqual(JSON.parse(es.stdout).groups[0].missing, ['es']);
        const synced = await runEf(root, ['i18n', 'synced', 'ro/despre']);
        assert.equal(synced.status, 0, synced.stderr);
        assert.ok(mock.reqs.some(r => r.method === 'POST' && /\/pages\/42\/translations\/synced$/.test(r.url)));
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('translations pull writes translations/<code>.json; push creates the language and upserts changed texts', async () => {
    const created: Array<Record<string, unknown>> = [];
    const mock = await startMock([
        ['GET', /\/translation-languages$/, () => ({ data: [{ id: 1, code: 'en', label: 'English', is_default: true, sort_order: 0, url_prefix: null }, ...created], current_page: 1, last_page: 1 })],
        ['POST', /\/translation-languages$/, (r) => { const l = { id: 9, ...r.body }; created.push(l); return { language: l }; }],
        ['GET', /\/translation-entries$/, (r) => /language_id=1/.test(r.url)
            ? { data: [{ id: 100, key: 'hero.title', value: 'Good days', brand_translation_language_id: 1 }, { id: 101, key: 'old', value: 'x', brand_translation_language_id: 1 }], current_page: 1, last_page: 1 }
            : { data: [], current_page: 1, last_page: 1 }],
        ['POST', /\/translation-entries\/bulk$/, (r) => ({ success: true, created: (r.body.entries as unknown[]).length, updated: 0, skipped: 0 })],
        ['DELETE', /\/translation-entries\/101$/, () => ({ success: true })],
    ]);
    const { root, brandRoot } = await setupProject(mock.url);
    try {
        let res = await runEf(root, ['translations', 'pull', '--json']);
        assert.equal(res.status, 0, res.stderr);
        const en = JSON.parse(await fs.promises.readFile(path.join(brandRoot, 'translations', 'en.json'), 'utf8'));
        assert.equal(en.entries['hero.title'], 'Good days');

        await fs.promises.writeFile(path.join(brandRoot, 'translations', 'ro.json'), JSON.stringify({
            language: { code: 'ro', label: 'Română', is_default: false, url_prefix: 'ro' },
            entries: { 'hero.title': 'Zile bune' },
        }));
        en.entries = { 'hero.title': 'Good days', 'nav.home': 'Home' };
        await fs.promises.writeFile(path.join(brandRoot, 'translations', 'en.json'), JSON.stringify(en));
        res = await runEf(root, ['translations', 'push', '--prune', '--json']);
        assert.equal(res.status, 0, res.stderr);
        const langPost = mock.reqs.find(r => r.method === 'POST' && /translation-languages$/.test(r.url))!;
        assert.equal(langPost.body.code, 'ro');
        assert.equal(langPost.body.url_prefix, 'ro');
        const bulks = mock.reqs.filter(r => /bulk$/.test(r.url));
        const enBulk = bulks.find(b => b.body.brand_translation_language_id === 1)!;
        assert.deepEqual(enBulk.body.entries, [{ key: 'nav.home', value: 'Home' }], 'unchanged texts are not resent');
        assert.ok(bulks.some(b => b.body.brand_translation_language_id === 9));
        assert.ok(mock.reqs.some(r => r.method === 'DELETE' && /\/translation-entries\/101$/.test(r.url)), '--prune deletes the dropped key');

        // ef push --all leaves the dictionary files alone.
        res = await runEf(root, ['push', '--all', '--json']);
        assert.equal(res.status, 0, res.stderr);
        assert.doesNotMatch(res.stderr, /translations/);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('i18n settings reads, validates and saves', async () => {
    let saved: Record<string, unknown> = { prefix_routing: false, x_default: null, prompt: 'off' };
    const mock = await startMock([
        ['GET', /\/i18n-settings$/, () => ({ i18n: saved })],
        ['PUT', /\/i18n-settings$/, (r) => { saved = r.body; return { i18n: saved }; }],
    ]);
    const { root } = await setupProject(mock.url);
    try {
        let res = await runEf(root, ['i18n', 'settings', '--prefix-routing', 'on', '--prompt', 'custom', '--x-default', 'EN', '--json']);
        assert.equal(res.status, 0, res.stderr);
        assert.deepEqual(saved, { prefix_routing: true, x_default: 'en', prompt: 'custom' });
        res = await runEf(root, ['i18n', 'settings', '--prompt', 'banner']);
        assert.equal(res.status, 2);
        res = await runEf(root, ['i18n', 'settings', '--json']);
        assert.equal(JSON.parse(res.stdout).changed, false);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
