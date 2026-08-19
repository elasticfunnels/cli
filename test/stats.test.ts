import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { addDays, resolveRange } from '../src/utils/dateRange';

/**
 * `ef stats`.
 *
 * Three of these are load-bearing against bugs that are invisible in the
 * output:
 *
 *  • `--from` used to be unreachable. `--range` carried a Commander default, so
 *    it was always "set", and the "--range or --from/--to, not both" guard
 *    fired on every explicit --from. The command still printed a table — for
 *    the wrong seven days.
 *
 *  • `tz` must be on every request. The API's fallback is America/Los_Angeles,
 *    not the brand's zone, so an omitted tz silently shifts every day boundary
 *    for a brand outside that offset and no output says so.
 *
 *  • The flat endpoint takes `selected_metrics` as a comma string and the
 *    grouped one rejects that with a 422, insisting on an array. Same
 *    subsystem, two conventions; if the client stops honouring the split, only
 *    the grouped commands break.
 */

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface Recorded { method: string; url: string }
interface Mock { url: string; requests: Recorded[]; close: () => Promise<void> }

function startMock(): Promise<Mock> {
    const requests: Recorded[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = req.url || '';
            requests.push({ method: req.method || '', url });
            const json = (payload: unknown): void => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };

            if (/\/analytics\/metrics\/data/.test(url)) {
                return json({
                    revenue: { value: 1200.5, formatted_value: '$1,200.50', change_percent: 12.5, change_symbol: '+', previous_value: 1067, previous_range_label: 'vs previous week' },
                    // Returned without being asked for — the resolver pulls in
                    // whatever a requested metric is derived from.
                    customers: { value: 9, formatted_value: '9' },
                    sessions: { value: 400, formatted_value: '400', change_percent: -8.25, change_symbol: '-', previous_value: 436, previous_range_label: 'vs previous week' },
                });
            }
            if (/\/analytics\/metrics\/split-test:321\/data/.test(url)) {
                return json({
                    _meta: { truncated: false },
                    'Control (v0)': { sessions: { value: 200, formatted: 200 }, conversion_rate: { value: 2.5, formatted: '2.50%' }, row_key: 'v0', row_label: 'Control' },
                    'Variant B (v1)': { sessions: { value: 210, formatted: 210 }, conversion_rate: { value: 3.1, formatted: '3.10%' }, row_key: 'v1', row_label: 'Variant B' },
                });
            }
            if (/\/analytics\/metrics\/page\/data/.test(url)) {
                return json({
                    'Index (10)': { revenue: { value: 10, formatted: '$10.00' }, row_key: 10, row_label: 'Index' },
                    'Vsl (11)': { revenue: { value: 90, formatted: '$90.00' }, row_key: 11, row_label: 'Vsl' },
                });
            }
            if (/\/analytics\/metrics\/day\/data/.test(url)) {
                return json({
                    '2026-08-03': { sessions: { value: 5, formatted: 5 }, row_key: '2026-08-03', row_label: '2026-08-03' },
                    '2026-08-01': { sessions: { value: 90, formatted: 90 }, row_key: '2026-08-01', row_label: '2026-08-01' },
                    '2026-08-02': { sessions: { value: 40, formatted: 40 }, row_key: '2026-08-02', row_label: '2026-08-02' },
                });
            }
            if (/\/analytics\/cards/.test(url)) {
                const scope = new URL(url, 'http://x').searchParams.get('scope');
                const scopes = ['brand', 'page', 'funnel', 'split_test', 'component_split_test'];
                if (scope && !scopes.includes(scope)) {
                    res.writeHead(422, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Unknown scope.', scopes }));
                }
                const all = [
                    { key: 'top_pages', name: 'Top Pages', description: 'Most visited pages', category: 'traffic_analytics', category_name: 'Traffic & Engagement', scopes, requires_integration: null, width: 6 },
                    { key: 'sub_mrr_trend', name: 'MRR Trend', description: 'Monthly recurring revenue', category: 'subscription_analytics', category_name: 'Subscriptions', scopes: ['brand'], requires_integration: null, width: 6 },
                    { key: 'st_winner_summary', name: 'Winner Summary', description: 'Leading variant', category: 'split_test_dashboard', category_name: 'Split Test Dashboard', scopes: ['split_test', 'component_split_test'], requires_integration: null, width: 6 },
                ];
                const data = scope ? all.filter(card => card.scopes.includes(scope)) : all;
                return json({
                    data,
                    categories: Object.fromEntries(data.map(card => [card.category, card.category_name])),
                    scopes,
                    scope: scope ?? null,
                });
            }
            if (/\/analytics\/metrics$/.test(url)) {
                return json({ revenue: { type: 'revenue', name: 'Topline Revenue', group_name: 'Revenue & Sales', info: 'Total revenue' } });
            }
            if (/\/split-tests\/321\/significance/.test(url)) {
                return json({ variants: [], baseline: 'Control', pvalue: 0.031, power: 0.82, sample_size_for_significance: 1500, winner: null });
            }
            if (/\/split-tests\/321$/.test(url)) return json({ id: 321, name: 'Headline test', type: 'page', status: 1 });
            // Anything not handled above is genuinely absent on this server —
            // answering 200 would hide exactly the missing-endpoint case the
            // card-catalog test exists to pin down.
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: `The route ${url} could not be found.` }));
            return;
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
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-stats-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
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

async function withBrand(fn: (root: string, mock: Mock) => Promise<void>): Promise<void> {
    const mock = await startMock();
    const root = await setupBrand(mock.url);
    try {
        await fn(root, mock);
    } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

// ── Range resolution ─────────────────────────────────────────────────

test('resolveRange: presets are inclusive of today', () => {
    const r = resolveRange({ range: '7d', tz: 'UTC' });
    assert.equal(addDays(r.start, 6), r.end, 'a 7d range must span 7 buckets, not 8');
    assert.equal(r.label, 'last 7 days');
});

test('resolveRange: yesterday is a single day', () => {
    const r = resolveRange({ range: 'yesterday', tz: 'UTC' });
    assert.equal(r.start, r.end);
    assert.equal(addDays(r.end, 1), resolveRange({ range: 'today', tz: 'UTC' }).start);
});

test('resolveRange: mtd and ytd anchor to the first of the period', () => {
    assert.match(resolveRange({ range: 'mtd', tz: 'UTC' }).start, /-01$/);
    assert.match(resolveRange({ range: 'ytd', tz: 'UTC' }).start, /-01-01$/);
});

test('resolveRange: --from/--to is usable without tripping the --range guard', () => {
    // The regression this file exists for. `range` unset must not read as "given".
    const r = resolveRange({ from: '2026-08-01', to: '2026-08-18', tz: 'UTC' });
    assert.equal(r.start, '2026-08-01');
    assert.equal(r.end, '2026-08-18');
});

test('resolveRange: an inverted range is rejected, not silently swapped', () => {
    assert.throws(() => resolveRange({ from: '2026-08-20', to: '2026-08-01', tz: 'UTC' }), /is after/);
});

test('resolveRange: --range together with --from is a usage error', () => {
    assert.throws(() => resolveRange({ range: '7d', from: '2026-08-01', tz: 'UTC' }), /not both/);
});

test('resolveRange: an unknown zone is rejected rather than falling back', () => {
    // Falling back would hand the server a different day boundary than asked for.
    assert.throws(() => resolveRange({ range: '7d', tz: 'Mars/Olympus' }), /not a known IANA timezone/);
});

test('addDays crosses month and DST boundaries by calendar, not by offset', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    // 2026-03-29 is the EU DST jump; anchoring at UTC noon keeps this exact.
    assert.equal(addDays('2026-03-29', -1), '2026-03-28');
});

// ── Command behaviour ────────────────────────────────────────────────

test('ef stats reports the requested metrics and drops resolver extras', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', '--metrics', 'revenue,sessions', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const out = JSON.parse(res.stdout) as { metrics: Array<{ metric: string; value: number }> };
        assert.deepEqual(out.metrics.map(m => m.metric), ['revenue', 'sessions'],
            '`customers` came back unrequested and must not appear');
        assert.equal(out.metrics[0].value, 1200.5);
    });
});

test('ef stats always sends tz, so the server never falls back to America/Los_Angeles', async () => {
    await withBrand(async (root, mock) => {
        await runEf(root, ['stats', '--metrics', 'revenue', '--tz', 'Europe/Bucharest']);
        const call = mock.requests.find(r => /metrics\/data/.test(r.url));
        assert.ok(call, 'no metrics request was made');
        assert.match(call.url, /tz=Europe%2FBucharest/);
    });
});

test('ef stats sends selected_metrics as a comma string, ef stats by sends an array', async () => {
    await withBrand(async (root, mock) => {
        await runEf(root, ['stats', '--metrics', 'revenue,sessions']);
        await runEf(root, ['stats', 'by', 'day', '--metrics', 'sessions']);

        const flat = mock.requests.find(r => /metrics\/data/.test(r.url))!;
        assert.match(flat.url, /selected_metrics=revenue(,|%2C)sessions/, 'flat endpoint takes a comma string');

        const grouped = mock.requests.find(r => /metrics\/day\/data/.test(r.url))!;
        assert.match(grouped.url, /selected_metrics(%5B%5D|\[\])=sessions/, 'grouped endpoint 422s on a comma string');
    });
});

test('ef stats by <temporal field> orders by the bucket, not by the value', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', 'by', 'day', '--metrics', 'sessions', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const out = JSON.parse(res.stdout) as { rows: Array<{ label: string }> };
        assert.deepEqual(out.rows.map(r => r.label), ['2026-08-01', '2026-08-02', '2026-08-03'],
            'a day series sorted by value is unreadable as a chart');
    });
});

test('ef stats by <non-temporal field> orders by the metric, descending', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', 'by', 'page', '--metrics', 'revenue', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const out = JSON.parse(res.stdout) as { rows: Array<{ label: string }> };
        assert.deepEqual(out.rows.map(r => r.label), ['Vsl', 'Index'], 'biggest first, unlike a time series');
    });
});

test('ef stats split reads per-variant metrics off the split-test:<id> dimension', async () => {
    await withBrand(async (root, mock) => {
        const res = await runEf(root, ['stats', 'split', '321', '--metrics', 'sessions,conversion_rate', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.ok(mock.requests.some(r => r.url.includes('/metrics/split-test:321/data')),
            'the colon must survive unescaped — %3A is not what the app sends');

        const out = JSON.parse(res.stdout) as {
            variants: Array<{ variant: string }>;
            significance: { pvalue: number; winner: string | null };
        };
        assert.deepEqual(out.variants.map(v => v.variant), ['Control', 'Variant B'],
            '`_meta` is an envelope key and must not become a variant row');
        assert.equal(out.significance.pvalue, 0.031);
        assert.equal(out.significance.winner, null);
    });
});

test('ef stats split reports the server verdict, and says why there is no winner', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', 'split', '321']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.match(res.stderr, /p-value/);
        assert.match(res.stderr, /1500/, 'the sample floor is the actionable part of "no winner yet"');
    });
});

test('ef stats metrics lists what the brand exposes, grouped', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', 'metrics', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const out = JSON.parse(res.stdout) as { metrics: Array<{ type: string; group_name: string }> };
        assert.equal(out.metrics[0].type, 'revenue');
        assert.equal(out.metrics[0].group_name, 'Revenue & Sales');
    });
});

test('ef stats cards lists the catalog with the scopes each card resolves in', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', 'cards', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const out = JSON.parse(res.stdout) as {
            scope: string | null;
            scopes: string[];
            cards: Array<{ key: string; scopes: string[] }>;
        };
        assert.equal(out.scope, null, 'no --scope means the whole catalog, not the brand scope');
        assert.deepEqual(out.cards.find(card => card.key === 'sub_mrr_trend')!.scopes, ['brand']);
        assert.ok(out.scopes.includes('component_split_test'), 'the vocabulary comes from the server');
    });
});

test('ef stats cards --scope asks the server, rather than filtering client-side', async () => {
    await withBrand(async (root, mock) => {
        const res = await runEf(root, ['stats', 'cards', '--scope', 'page', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        // Client-side filtering would be a second copy of a rule that already
        // lives in the app's card registry, and would drift from it.
        assert.match(mock.requests.find(r => /analytics\/cards/.test(r.url))!.url, /scope=page/);

        const out = JSON.parse(res.stdout) as { cards: Array<{ key: string }> };
        assert.deepEqual(out.cards.map(card => card.key), ['top_pages'],
            'a brand-only card must not be offered for a page report');
    });
});

test('ef stats cards accepts a hyphenated scope name', async () => {
    await withBrand(async (root, mock) => {
        const res = await runEf(root, ['stats', 'cards', '--scope', 'split-test', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.match(mock.requests.find(r => /analytics\/cards/.test(r.url))!.url, /scope=split_test/,
            'every other flag on this command is hyphenated; both spellings must reach the same scope');
    });
});

test('ef stats cards surfaces the real scope list when the name is wrong', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', 'cards', '--scope', 'pages']);
        assert.equal(res.status, 2, 'a mistyped scope is a usage error');
        assert.match(res.stderr, /Unknown scope/);
        assert.match(res.stderr, /component_split_test/, 'the reply already holds the correction');
    });
});

test('ef stats cards --category narrows to one registry family', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', 'cards', '--category', 'subscription', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const out = JSON.parse(res.stdout) as { cards: Array<{ key: string }> };
        assert.deepEqual(out.cards.map(card => card.key), ['sub_mrr_trend']);
    });
});

test('ef stats rejects a bad range with the usage exit code', async () => {
    await withBrand(async (root) => {
        const res = await runEf(root, ['stats', '--range', 'bogus']);
        assert.equal(res.status, 2);
        assert.match(res.stderr, /Unknown --range/);
    });
});

test('analyticsTz in .ef/config.json is honoured, and --tz still overrides it', async () => {
    // `loadConfig` rebuilds the config from an allow-list, so a key that is not
    // named there is dropped on read — the setting appeared to save and then
    // did nothing. Both halves of the precedence chain are asserted here.
    await withBrand(async (root, mock) => {
        const cfgPath = path.join(root, '.ef', 'config.json');
        const cfg = JSON.parse(await fs.promises.readFile(cfgPath, 'utf8')) as Record<string, unknown>;
        await fs.promises.writeFile(cfgPath, JSON.stringify({ ...cfg, analyticsTz: 'America/New_York' }));

        await runEf(root, ['stats', '--metrics', 'revenue']);
        assert.match(mock.requests.find(r => /metrics\/data/.test(r.url))!.url, /tz=America%2FNew_York/);

        mock.requests.length = 0;
        await runEf(root, ['stats', '--metrics', 'revenue', '--tz', 'Asia/Tokyo']);
        assert.match(mock.requests.find(r => /metrics\/data/.test(r.url))!.url, /tz=Asia%2FTokyo/);
    });
});

test('ef stats cards explains an older server instead of reporting a bare 404', async () => {
    // The catalog endpoint ships after the rest of the analytics surface, so a
    // brand on an older server has every other stats command working and only
    // this one missing. A raw 404 there reads as a broken CLI or a bad brand id.
    // A server predating the catalog, so this cannot pass by accident against
    // the mock that already serves it.
    const server = http.createServer((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'The route could not be found.' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const root = await setupBrand(`http://127.0.0.1:${port}`);
    try {
        const res = await runEf(root, ['stats', 'cards']);
        assert.equal(res.status, 7, `not-found exit code; stderr=${res.stderr}`);
        assert.match(res.stderr, /does not expose the card catalog yet/);
        assert.match(res.stderr, /Every other "ef stats" command works/);
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('a variant whose label is empty prints something visible, not a blank row', async () => {
    // Seen for real: a split test reported variants as "j:null" and "" — the
    // numbers were right and the labels were mangled upstream. A row that
    // renders as an empty line reads as a rendering glitch, which sends the
    // reader looking in the wrong place for the fault.
    const server = http.createServer((req, res) => {
        const url = req.url || '';
        res.writeHead(200, { 'content-type': 'application/json' });
        if (/\/analytics\/metrics\/split-test:9\/data/.test(url)) {
            res.end(JSON.stringify({
                '': { sessions: { value: 4, formatted: 4 }, row_key: '', row_label: '' },
                'j:null': { sessions: { value: 1, formatted: 1 }, row_key: 'j:null', row_label: null },
            }));
            return;
        }
        res.end(JSON.stringify({ id: 9, name: 'Broken labels', type: 'page' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const root = await setupBrand(`http://127.0.0.1:${port}`);
    try {
        const res = await runEf(root, ['stats', 'split', '9', '--metrics', 'sessions', '--json']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        const out = JSON.parse(res.stdout) as { variants: Array<{ variant: string }> };
        for (const v of out.variants) {
            assert.notEqual(v.variant.trim(), '', 'every variant row carries a visible label');
        }
        assert.ok(out.variants.some(v => v.variant === '(unlabeled)'), 'the empty one is named as such');
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
