import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { withEfMeta } from '../src/sync/efMeta';

/**
 * `ef seo` + `ef pages settings --sitemap`.
 *
 * The load-bearing assertion is the third test: `--sitemap` and `--no-sitemap`
 * are declared as a Commander pair, and Commander defaults a `--no-x` flag to
 * TRUE when it is declared alone. If that ever regresses, every unrelated
 * `ef pages settings <slug> --title …` would quietly publish that page to
 * sitemap.xml — a silent leak of funnel steps and checkouts, with nothing in
 * the output to notice.
 */

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Recorded { method: string; url: string; body: Record<string, unknown> }
interface Mock { url: string; requests: Recorded[]; close: () => Promise<void> }

function startMock(seo: Record<string, unknown>, pages: unknown[]): Promise<Mock> {
    const requests: Recorded[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                const url = req.url || '';
                let body: Record<string, unknown> = {};
                try { body = JSON.parse(raw || '{}'); } catch { /* {} */ }
                requests.push({ method: req.method || '', url, body });

                const json = (payload: unknown): void => {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(payload));
                };

                if (req.method === 'GET' && /\/seo\/pages$/.test(url)) return json({ data: pages });
                if (req.method === 'GET' && /\/seo$/.test(url)) return json({ data: seo });
                if (req.method === 'PUT' && /\/seo$/.test(url)) {
                    Object.assign(seo, body);
                    return json({ message: 'ok', seo_config: seo });
                }
                if (req.method === 'GET' && /\/pages\/all/.test(url)) {
                    return json([{ id: 42, slug: 'pricing', variant_slug: null, title: 'Pricing', is_active_version: true, updated_at: '2026-01-01T00:00:00Z' }]);
                }
                if (req.method === 'PUT' && /\/pages\/42$/.test(url)) {
                    return json({ id: 42, slug: 'pricing', variant_slug: null, title: (body.title as string) ?? 'Pricing', updated_at: '2026-01-02T00:00:00Z' });
                }
                return json({});
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                requests,
                close: () => new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

async function setupBrand(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-seo-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'pages'), { recursive: true });
    await fs.promises.writeFile(
        path.join(brandRoot, 'pages', 'pricing.ef'),
        withEfMeta({ v: 1, type: 'page', brandId: 7, id: 42, slug: 'pricing', path: 'pages/pricing.ef' }, '<h1>Pricing</h1>'),
    );
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

const OFF = { sitemap_enabled: false, llms_enabled: false, robots_enabled: false, site_name: null, site_name_effective: 'Acme', site_summary: null, llms_notes: null, robots_extra: null };

test('ef seo status reports every file off and says nothing is served', async () => {
    const mock = await startMock({ ...OFF }, []);
    const root = await setupBrand(mock.url);
    try {
        const res = await runEf(root, ['seo', 'status']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.match(res.stderr, /sitemap\.xml\s+off/);
        assert.match(res.stderr, /llms\.txt\s+off/);
        assert.match(res.stderr, /robots\.txt\s+off/);
        assert.match(res.stderr, /every one of these paths 404s/);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('ef seo set maps CLI keys onto API fields and coerces booleans', async () => {
    const mock = await startMock({ ...OFF }, []);
    const root = await setupBrand(mock.url);
    try {
        const on = await runEf(root, ['seo', 'set', 'sitemap', 'true']);
        assert.equal(on.status, 0, `stderr=${on.stderr}`);
        const put = mock.requests.find((r) => r.method === 'PUT' && /\/seo$/.test(r.url));
        assert.deepEqual(put?.body, { sitemap_enabled: true }, 'sends only the named field, as sitemap_enabled');

        // It should say the sitemap has no pages and no robots.txt points at it.
        assert.match(on.stderr, /robots\.txt is still off/);
        assert.match(on.stderr, /No page has opted in yet/);

        const off = await runEf(root, ['seo', 'set', 'llms', 'off']);
        assert.equal(off.status, 0, `stderr=${off.stderr}`);
        const llms = mock.requests.filter((r) => r.method === 'PUT').pop();
        assert.deepEqual(llms?.body, { llms_enabled: false }, '"off" coerces to false');

        const text = await runEf(root, ['seo', 'set', 'site-name', 'Acme Supplements']);
        assert.equal(text.status, 0, `stderr=${text.stderr}`);
        const name = mock.requests.filter((r) => r.method === 'PUT').pop();
        assert.deepEqual(name?.body, { site_name: 'Acme Supplements' }, 'text keys are not coerced');

        const bad = await runEf(root, ['seo', 'set', 'sitemap', 'maybe']);
        assert.notEqual(bad.status, 0, 'a non-boolean value for a boolean key must fail');
        assert.match(bad.stderr, /boolean/);

        const unknown = await runEf(root, ['seo', 'set', 'nonsense', 'true']);
        assert.notEqual(unknown.status, 0, 'an unknown key must fail rather than silently no-op');
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('pages settings only touches include_in_sitemap when --sitemap/--no-sitemap is passed', async () => {
    const mock = await startMock({ ...OFF }, []);
    const root = await setupBrand(mock.url);
    try {
        // The regression that matters: an unrelated edit must NOT list the page.
        const untouched = await runEf(root, ['pages', 'settings', 'pricing', '--title', 'Pricing 2', '--json']);
        assert.equal(untouched.status, 0, `stderr=${untouched.stderr}`);
        const plain = mock.requests.filter((r) => r.method === 'PUT' && /\/pages\/42$/.test(r.url)).pop();
        assert.ok(plain, 'the page PUT happened');
        assert.equal(
            'include_in_sitemap' in (plain!.body),
            false,
            'a settings call that never mentioned the sitemap must not send the field at all',
        );

        const listed = await runEf(root, ['pages', 'settings', 'pricing', '--sitemap', '--json']);
        assert.equal(listed.status, 0, `stderr=${listed.stderr}`);
        const on = mock.requests.filter((r) => r.method === 'PUT' && /\/pages\/42$/.test(r.url)).pop();
        assert.equal(on?.body.include_in_sitemap, true);

        const unlisted = await runEf(root, ['pages', 'settings', 'pricing', '--no-sitemap', '--json']);
        assert.equal(unlisted.status, 0, `stderr=${unlisted.stderr}`);
        const off = mock.requests.filter((r) => r.method === 'PUT' && /\/pages\/42$/.test(r.url)).pop();
        assert.equal(off?.body.include_in_sitemap, false);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('ef seo pages says WHY an opted-in page is not listed', async () => {
    const mock = await startMock({ ...OFF, sitemap_enabled: true }, [
        { id: 42, title: 'Pricing', slug: 'pricing', path: '/pricing', domain: 'shop.example.com', description: null, listed: true, excluded_reason: null },
        { id: 43, title: 'Blog post', slug: 'blog/{slug}', path: '/blog/{slug}', domain: null, description: null, listed: false, excluded_reason: 'pattern_slug' },
        { id: 44, title: 'Draft guide', slug: 'guide', path: '/guide', domain: null, description: null, listed: false, excluded_reason: 'not_published' },
    ]);
    const root = await setupBrand(mock.url);
    try {
        const res = await runEf(root, ['seo', 'pages']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.match(res.stdout, /shop\.example\.com\/pricing/);
        // A bare "NOT LISTED" would leave the user with a ticked box and no
        // explanation — the reason is the whole point of returning these rows.
        assert.match(res.stdout, /NOT LISTED — slug is a \{param\} route pattern/);
        assert.match(res.stdout, /NOT LISTED — page is not published/);

        // The status count must exclude them, or it promises entries the file
        // will never contain.
        const status = await runEf(root, ['seo', 'status', '--json']);
        const parsed = JSON.parse(status.stdout);
        assert.equal(parsed.listed_pages, 1);
        assert.equal(parsed.excluded_pages, 2);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
