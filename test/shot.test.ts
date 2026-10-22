import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { chunkPlan, findChromium, parseSizes, resolveChunk, shotFileName, staleShots } from '../src/commands/shot';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

test('parseSizes: presets, both, WxH and comma lists', () => {
    assert.deepEqual(parseSizes('desktop').map((s) => [s.width, s.height, s.mobile]), [[1440, 900, false]]);
    assert.deepEqual(parseSizes('both').map((s) => s.name), ['desktop', 'mobile']);
    assert.deepEqual(parseSizes('1280x720, mobile').map((s) => s.name), ['1280x720', 'mobile']);
    assert.equal(parseSizes('600x900')[0].mobile, true);
    assert.throws(() => parseSizes('huge'), /Bad --size/);
    assert.throws(() => parseSizes('99x10'), /out of range/);
    assert.throws(() => parseSizes(' , '), /empty/);
});

test('chunkPlan covers the page with no gaps', () => {
    assert.deepEqual(chunkPlan(900, 0), [{ y: 0, height: 900 }]);
    assert.deepEqual(chunkPlan(900, 1600), [{ y: 0, height: 900 }]);
    assert.deepEqual(chunkPlan(3500, 1600), [{ y: 0, height: 1600 }, { y: 1600, height: 1600 }, { y: 3200, height: 300 }]);
});

test('resolveChunk: auto is 1500 on wide screens, 1300 on phones; numbers pass; junk is refused', () => {
    assert.equal(resolveChunk('auto', parseSizes('desktop')[0]), 1500);
    assert.equal(resolveChunk('auto', parseSizes('mobile')[0]), 1300);
    assert.equal(resolveChunk('0', parseSizes('mobile')[0]), 0);
    assert.equal(resolveChunk('900', parseSizes('desktop')[0]), 900);
    assert.throws(() => resolveChunk('-5', parseSizes('desktop')[0]), /--chunk/);
    assert.throws(() => resolveChunk('big', parseSizes('desktop')[0]), /--chunk/);
});

test('staleShots finds only this page and size', () => {
    const files = ['sales-draft-mobile.png', 'sales-draft-mobile-1.png', 'sales-draft-mobile-12.png', 'sales-draft-desktop-1.png', 'sales-draft-mobile-x.png', 'sales-draft-mobile.jpg', 'other-mobile-1.png'];
    assert.deepEqual(staleShots(files, 'sales-draft', 'mobile', 'png'), ['sales-draft-mobile.png', 'sales-draft-mobile-1.png', 'sales-draft-mobile-12.png']);
});

test('shotFileName keeps names to safe characters', () => {
    assert.equal(shotFileName('blog/post-draft', 'mobile', 'png', null), 'blog-post-draft-mobile.png');
    assert.equal(shotFileName('../../etc', 'desktop', 'jpg', 1), 'etc-desktop-2.jpg');
    assert.equal(shotFileName('///', 'desktop', 'png', null), 'page-desktop.png');
});

test('findChromium: EF_CHROME_PATH wins, and a missing one means none', () => {
    assert.equal(findChromium({ EF_CHROME_PATH: '/x/chrome' }, (p) => p === '/x/chrome'), '/x/chrome');
    assert.equal(findChromium({ EF_CHROME_PATH: '/x/chrome' }, () => false), null);
    assert.equal(findChromium({ PLAYWRIGHT_BROWSERS_PATH: '/none' }, () => false), null);
});

function pngSize(file: string): { width: number; height: number } {
    const b = fs.readFileSync(file);
    assert.equal(b.toString('ascii', 1, 4), 'PNG');
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}section{height:1000px}</style></head><body>
<section style="background:#eee">top</section>
<section id="pricing" style="height:400px;background:#fc0">pricing</section>
<section style="background:#ddd">bottom</section>
<div class="wide-promo" style="width:520px;height:20px"></div>
<div id="debug-window" style="position:fixed;bottom:0;left:0;right:0;height:80px;background:red">Elastic Debug</div>
</body></html>`;

interface Mock { url: string; hits: string[]; close: () => Promise<void> }

function startMock(): Promise<Mock> {
    const mock = { hits: [] as string[] } as Mock;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const p = (req.url || '').split('?')[0];
            mock.hits.push(p);
            const json = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (p === '/page' || p === '/live') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
            if (p === '/bare') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>hi</p>'); }
            if (p === '/gone') { res.writeHead(404); return res.end('no'); }
            if (/\/pages\/all$/.test(p)) return json([{ id: 42, slug: 'sales', status: 'published' }]);
            if (/\/pages\/42\/editor\/preview-url$/.test(p)) return json({ url: `${mock.url}/page?key=k&preview=1` });
            if (/\/pages\/42\/editor\/live-url$/.test(p)) return json({ url: `${mock.url}/live` });
            if (/\/pages\/42\/editor$/.test(p)) return json({ id: 42, slug: 'sales', status: 'published', html: '', revision_id: 9 });
            json({});
        });
        server.listen(0, '127.0.0.1', () => {
            mock.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            mock.close = () => new Promise<void>((r) => server.close(() => r()));
            resolve(mock);
        });
    });
}

function runEf(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

async function withProject(fn: (root: string, mock: Mock) => Promise<void>): Promise<void> {
    const mock = await startMock();
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-shot-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl: mock.url, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    try { await fn(root, mock); } finally {
        await mock.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

test('without a browser: --check exits 1 with the fix, and a shot stops before calling the API', () => withProject(async (root, mock) => {
    const env = { EF_CHROME_PATH: path.join(root, 'no-chrome') };
    const check = await runEf(root, ['shot', '--check', '--json'], env);
    assert.equal(check.status, 1);
    const out = JSON.parse(check.stdout);
    assert.equal(out.ready, false);
    assert.equal(out.chromium, null);
    assert.match(out.fix, /ef shot --install/);
    const shot = await runEf(root, ['shot', 'sales'], env);
    assert.equal(shot.status, 1);
    assert.match(shot.stderr, /ef shot --install/);
    assert.deepEqual(mock.hits, []);
}));

test('bad options exit 2', () => withProject(async (root) => {
    assert.equal((await runEf(root, ['shot', 'sales', '--size', 'tiny'])).status, 2);
    assert.equal((await runEf(root, ['shot', 'sales', '--chunk', '-5'])).status, 2);
    assert.equal((await runEf(root, ['shot', 'sales', '--quality', '50'])).status, 2);
    assert.equal((await runEf(root, ['shot', 'sales', '--selector', 'h1', '--viewport'])).status, 2);
    assert.equal((await runEf(root, ['shot'])).status, 2);
}));

const browser = findChromium();

test('shoots the draft full page, chunks, a selector, the live page and a 404', { skip: browser ? false : 'no Chromium on this machine' }, () => withProject(async (root, mock) => {
    const out = path.join(root, 'shots');
    const full = await runEf(root, ['shot', 'sales', '--size', '800x600', '--chunk', '0', '--wait', '0', '--out', out, '--json']);
    assert.equal(full.status, 0, full.stderr);
    const r = JSON.parse(full.stdout);
    assert.equal(r.kind, 'draft');
    assert.match(r.url, /\/page\?key=k/);
    assert.equal(r.files.length, 1);
    assert.deepEqual(pngSize(r.files[0].file), { width: 800, height: 2420 });
    assert.equal(r.pages[0].overflowX, false);
    assert.ok(mock.hits.includes('/page'));

    const chunks = await runEf(root, ['shot', 'sales', '--size', '800x600', '--chunk', '1000', '--wait', '0', '--out', out, '--json']);
    assert.equal(chunks.status, 0, chunks.stderr);
    const heights = JSON.parse(chunks.stdout).files.map((f: { file: string }) => pngSize(f.file).height);
    assert.deepEqual(heights, [1000, 1000, 420]);

    // Default auto pieces (1500 on desktop) replace the 3 old ones: no stale -3 left behind.
    const auto = await runEf(root, ['shot', 'sales', '--size', '800x600', '--wait', '0', '--out', out, '--json']);
    assert.equal(auto.status, 0, auto.stderr);
    assert.deepEqual(JSON.parse(auto.stdout).files.map((f: { file: string }) => pngSize(f.file).height), [1500, 920]);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.startsWith('sales-draft-800x600')).sort(), ['sales-draft-800x600-1.png', 'sales-draft-800x600-2.png']);

    // On a phone the 520px promo sticks out: warned, and named.
    const phone = await runEf(root, ['shot', 'sales', '--size', 'mobile', '--wait', '0', '--out', out]);
    assert.equal(phone.status, 0, phone.stderr);
    assert.match(phone.stderr, /520px wide on a 390px screen/);
    assert.match(phone.stderr, /div\.wide-promo/);
    assert.doesNotMatch(phone.stderr, /no <meta name="viewport">/);
    const bare = await runEf(root, ['shot', `${mock.url}/bare`, '--size', 'mobile', '--wait', '0', '--out', out, '--json']);
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(JSON.parse(bare.stdout).pages[0].noViewportMeta, true);

    const sel = await runEf(root, ['shot', 'sales', '--live', '--selector', '#pricing', '--size', '800x600', '--wait', '0', '--out', out, '--json']);
    assert.equal(sel.status, 0, sel.stderr);
    const s = JSON.parse(sel.stdout);
    assert.equal(s.kind, 'live');
    assert.deepEqual(pngSize(s.files[0].file), { width: 800, height: 400 });

    const missing = await runEf(root, ['shot', 'sales', '--selector', '#nope', '--wait', '0', '--out', out]);
    assert.equal(missing.status, 7);

    const gone = await runEf(root, ['shot', `${mock.url}/gone`, '--wait', '0', '--out', out]);
    assert.equal(gone.status, 7);
    assert.match(gone.stderr, /HTTP 404/);
}));
