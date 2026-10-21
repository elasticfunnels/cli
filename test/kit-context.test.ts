import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { ApiClient } from '../src/api/client';
import { pullKitContext, convertPendingBriefs } from '../src/lib/kitContext';
import { syncDrive } from '../src/lib/driveSync';
import { buildGenerateRequest } from '../src/commands/images';
import { parseFactValue, setPath } from '../src/commands/context';
import type { HttpGet } from '../src/lib/driveFetch';
import { sampleDocx } from './helpers/zipWriter';

/**
 * `ef context`, `ef assets add|sync-drive` and `ef images generate` against a stand-in for the
 * app's /api/brands/{b}/ai-context endpoints (P1 contract) and KitImagesController.
 */

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

interface Req { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }

function startMock() {
    const requests: Req[] = [];
    const blobs: Record<string, Buffer> = { '/cdn/packshot.png': Buffer.from('PACKSHOT-1'), '/cdn/brief.pdf': Buffer.from('%PDF-brief') };
    const state = {
        context: {
            id: 5, template_apply_run_id: 77, builder_resource_id: 31, brief_md: 'Sell Calvessa chews.', facts: { price: 49 } as Record<string, unknown>,
            drive_url: null as string | null, drive_synced_at: null, drive_manifest: null, status: 'active',
            kit: { id: 31, key: 'supplement-vsl', name: 'Supplement VSL', run_id: 77, pages: [{ id: 1, slug: 'vsl', role: 'sales' }], products: [{ id: 9, old_code: 'NW1', code: 'CAL1', name: 'Calvessa VesselGuard Chews' }] },
        },
        assets: [] as Array<Record<string, unknown>>,
        files: [{ id: 3, name: 'brief.pdf', mime: 'application/pdf', url: '', sha256: sha(blobs['/cdn/brief.pdf']), converted_md: 'Brief from PDF', drive_file_id: null }] as Array<Record<string, unknown>>,
        slots: [{ id: 11, slot: 'hero', prompt: 'A bottle on a kitchen table', aspect: '4:5', status: 'planned', url: null, applied: [{ slug: 'vsl', id: 1, selector: '#hero' }] }],
        missing: [
            { kind: 'slot_image', key: 'hero', label: 'No image for hero', pages: ['vsl'], fix: 'generate', blocking: false },
            { kind: 'drive', key: 'drive', label: 'Drive sync incomplete', pages: [], fix: 'upload', blocking: true },
        ],
        image: { id: 400, slot: 'hero', status: 'queued', credits: 101, url: null as string | null },
        imagePolls: 0,
    };
    let base = '';
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            const url = (req.url || '').split('?')[0];
            const body = Buffer.concat(chunks);
            requests.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
            const json = (p: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
            if (blobs[url]) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(blobs[url]); return; }
            const bundle = () => ({ context: state.context, assets: state.assets, files: state.files.map((f) => ({ ...f, url: f.url || `${base}/cdn/brief.pdf` })), slots: state.slots });
            if (req.method === 'GET' && url === '/api/brands/7/ai-context') return json(bundle());
            if (req.method === 'PUT' && url === '/api/brands/7/ai-context') {
                const b = JSON.parse(body.toString('utf8'));
                Object.assign(state.context, b);
                return json(bundle());
            }
            if (req.method === 'GET' && url === '/api/brands/7/ai-context/missing') return json({ data: state.missing });
            if (req.method === 'POST' && (url === '/api/brands/7/ai-context/assets' || url === '/api/brands/7/ai-context/files')) {
                const text = body.toString('latin1');
                const field = (n: string) => (new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(text) || [])[1] ?? null;
                const filename = (/filename="([^"]+)"/.exec(text) || [])[1];
                const row = { id: 100 + requests.length, name: filename, url: `${base}/cdn/packshot.png`, source: field('source'), product_code: field('product_code'), role: field('role'), drive_file_id: field('drive_file_id'), converted_md: field('converted_md'), sha256: sha(blobs['/cdn/packshot.png']) };
                if (url.endsWith('/assets')) { state.assets.push(row); return json({ asset: row }, 201); }
                state.files.push(row); return json({ file: row }, 201);
            }
            const patch = /^\/api\/brands\/7\/ai-context\/files\/(\d+)$/.exec(url);
            if (req.method === 'PATCH' && patch) {
                const f = state.files.find((x) => x.id === Number(patch[1]));
                if (!f) return json({ message: 'nope' }, 404);
                f.converted_md = JSON.parse(body.toString('utf8')).converted_md;
                return json({ file: f });
            }
            if (req.method === 'GET' && url === '/api/brands/7/ai-images/estimate') return json({ credits_per_image: 101, count: 1, total_credits: 101, balance: 500, balance_after: 399, can_afford: true });
            if (req.method === 'POST' && url === '/api/brands/7/ai-images') return json({ image: state.image }, 202);
            if (req.method === 'GET' && url === '/api/brands/7/ai-images/400') {
                state.imagePolls++;
                return json({ image: { ...state.image, status: 'done', url: `${base}/cdn/gen.png` } });
            }
            json({ message: 'not found' }, 404);
        });
    });
    return new Promise<{ url: string; requests: Req[]; state: typeof state; blobs: typeof blobs; close: () => Promise<void> }>((resolve) => server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        base = `http://127.0.0.1:${port}`;
        state.assets.push({ id: 21, name: 'Bottle.png', url: `${base}/cdn/packshot.png`, kind: 'product', source: 'upload', product_code: 'CAL1', role: 'packshot', drive_file_id: 'drv1', sha256: sha(blobs['/cdn/packshot.png']) });
        resolve({ url: base, requests, state, blobs, close: () => new Promise<void>((r) => server.close(() => r())) });
    }));
}

async function setup(apiUrl: string): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-ctx-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.ef', 'config.json'), JSON.stringify({ apiUrl, brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'draft' }));
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'secret-key\n');
    return root;
}

function runEf(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', EF_NO_UPDATE_CHECK: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('ef context pull writes every file, downloads assets without the API key, and is idempotent', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        const r1 = await runEf(root, ['context', 'pull', '--json']);
        assert.equal(r1.code, 0, r1.stderr);
        const j1 = JSON.parse(r1.stdout);
        assert.equal(j1.hasContext, true);
        assert.equal(j1.blockers, 1);
        assert.equal(j1.downloaded.length, 2);
        const dir = path.join(root, '.ef', 'context');
        const kit = JSON.parse(fs.readFileSync(path.join(dir, 'kit.json'), 'utf8'));
        assert.equal(kit.run_id, 77);
        assert.deepEqual(kit.products[0], { id: 9, old_code: 'NW1', code: 'CAL1', name: 'Calvessa VesselGuard Chews' });
        assert.equal(fs.readFileSync(path.join(dir, 'brief.md'), 'utf8'), 'Sell Calvessa chews.\n\n## From brief.pdf\n\nBrief from PDF\n');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8')), { price: 49 });
        const assets = JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8'));
        assert.equal(assets.assets[0].local, 'assets/a21-Bottle.png');
        assert.equal(fs.readFileSync(path.join(dir, assets.assets[0].local), 'utf8'), 'PACKSHOT-1');
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'slots.json'), 'utf8'))[0].slot, 'hero');
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'missing.json'), 'utf8')).length, 2);
        const cdn = mock.requests.filter((q) => q.url.startsWith('/cdn/'));
        assert.equal(cdn.length, 2);
        assert.ok(cdn.every((q) => !q.headers['ef-access-key'] && !q.headers.authorization), 'asset downloads never carry the brand credential');
        const api = mock.requests.find((q) => q.url === '/api/brands/7/ai-context');
        assert.equal(api?.headers['ef-access-key'], 'secret-key');

        // Second pull: nothing re-downloaded, nothing rewritten.
        const r2 = await runEf(root, ['context', 'pull', '--json']);
        const j2 = JSON.parse(r2.stdout);
        assert.deepEqual(j2.downloaded, []);
        assert.deepEqual(j2.written, []);
        assert.equal(mock.requests.filter((q) => q.url.startsWith('/cdn/')).length, 2);

        // The packshot changes on the server: only it is fetched again. An asset that goes away is removed.
        mock.blobs['/cdn/packshot.png'] = Buffer.from('PACKSHOT-2');
        mock.state.assets[0].sha256 = sha('PACKSHOT-2');
        const j3 = JSON.parse((await runEf(root, ['context', 'pull', '--json'])).stdout);
        assert.deepEqual(j3.downloaded, ['a21-Bottle.png']);
        assert.deepEqual(j3.written, ['assets.json']);
        mock.state.assets = [];
        const j4 = JSON.parse((await runEf(root, ['context', 'pull', '--json'])).stdout);
        assert.deepEqual(j4.removed, ['a21-Bottle.png']);
        assert.ok(!fs.existsSync(path.join(dir, 'assets', 'a21-Bottle.png')));

        const miss = await runEf(root, ['context', 'missing']);
        assert.equal(miss.code, 0);
        assert.match(miss.stdout.split('\n')[0], /^BLOCKER \[drive\] Drive sync incomplete/);
    } finally {
        await mock.close();
    }
});

test('ef context facts set / brief set write back; ef assets add uploads with product + role', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        let r = await runEf(root, ['context', 'facts', 'set', 'guarantee.days', '60']);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(mock.state.context.facts, { price: 49, guarantee: { days: 60 } });
        await runEf(root, ['context', 'facts', 'set', 'ingredients', '["nattokinase","K2"]']);
        assert.deepEqual((mock.state.context.facts as Record<string, unknown>).ingredients, ['nattokinase', 'K2']);

        fs.writeFileSync(path.join(root, 'brief.docx'), sampleDocx());
        r = await runEf(root, ['context', 'brief', 'set', '--file', 'brief.docx']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(String(mock.state.context.brief_md), /^# Calvessa Brief/);
        r = await runEf(root, ['context', 'brief', 'set', '--file', 'x.pdf']);
        assert.notEqual(r.code, 0);

        fs.writeFileSync(path.join(root, 'front.png'), 'IMG');
        r = await runEf(root, ['assets', 'add', 'front.png', '--product', 'CAL1', '--role', 'packshot', '--json']);
        assert.equal(r.code, 0, r.stderr);
        const added = mock.state.assets[mock.state.assets.length - 1];
        assert.equal(added.product_code, 'CAL1');
        assert.equal(added.role, 'packshot');
        assert.equal(added.source, 'upload');
        r = await runEf(root, ['assets', 'add', 'front.png', '--role', 'hero']);
        assert.equal(r.code, 2);
        fs.writeFileSync(path.join(root, 'tool.exe'), 'x');
        r = await runEf(root, ['assets', 'add', 'tool.exe']);
        assert.equal(r.code, 2);
    } finally {
        await mock.close();
    }
});

test('ef images generate: shows the cost, refuses without --yes when not interactive, honours --max-credits, then generates and waits', async () => {
    const mock = await startMock();
    const root = await setup(mock.url);
    try {
        let r = await runEf(root, ['images', 'generate', '--slot', 'hero']);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /costs 101 AI credits\. Re-run with --yes/);
        assert.ok(!mock.requests.some((q) => q.method === 'POST' && q.url.startsWith('/api/brands/7/ai-images')));

        r = await runEf(root, ['images', 'generate', '--slot', 'hero', '--yes', '--max-credits', '50']);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /over the cap of 50/);

        // A cap that is not a whole number used to parse to NaN and skip the check.
        for (const bad of ['abc', '-5', '1e3', '12.5']) {
            r = await runEf(root, ['images', 'generate', '--slot', 'hero', '--yes', `--max-credits=${bad}`]);
            assert.equal(r.code, 2, `${bad}: ${r.stderr}`);
            assert.match(r.stderr, /--max-credits takes a whole number/);
        }
        assert.ok(!mock.requests.some((q) => q.method === 'POST' && q.url.startsWith('/api/brands/7/ai-images')), 'a bad cap never reaches the generate call');

        r = await runEf(root, ['images', 'generate', '--slot', 'hero', '--product', 'CAL1', '--aspect', '1:1', '--yes', '--max-credits', '200', '--json'], { EF_IMAGE_POLL_MS: '10' });
        assert.equal(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.image.status, 'done');
        const post = mock.requests.find((q) => q.method === 'POST' && q.url === '/api/brands/7/ai-images')!;
        const sent = JSON.parse(post.body.toString('utf8'));
        assert.equal(sent.kit_id, 31);
        assert.equal(sent.slot, 'hero');
        assert.equal(sent.aspect, '1:1');
        assert.deepEqual(sent.reference_ids, [21]);
        assert.match(sent.prompt, /^A bottle on a kitchen table\n\nThe product is "Calvessa VesselGuard Chews"/);
        assert.match(sent.idempotency_key, /^[0-9a-f]{32}$/);
        assert.equal(sent.max_credits, 200, 'the cap rides along for the server to enforce');

        r = await runEf(root, ['images', 'generate', '--prompt', 'x y z', '--yes']);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /Pass --slot/);
    } finally {
        await mock.close();
    }
});

test('buildGenerateRequest, parseFactValue, setPath', () => {
    const b = { context: { id: 1, builder_resource_id: 31, kit: { products: [{ code: 'A', name: 'Alpha' }] } }, assets: [{ id: 2, url: '', product_code: 'A', role: 'label' }, { id: 3, url: '', product_code: 'A', role: 'lifestyle' }], files: [], slots: [{ slot: 's', prompt: 'p p p', aspect: '4:5' }] };
    const r = buildGenerateRequest(b as never, { slot: 's', product: 'A' });
    assert.deepEqual(r.referenceIds, [2]);
    assert.equal(r.aspect, '4:5');
    assert.deepEqual(buildGenerateRequest(b as never, { slot: 's', product: 'A', reference: ['7,8'] }).referenceIds, [7, 8]);
    assert.throws(() => buildGenerateRequest(b as never, { slot: 's', product: 'ZZ' }), /No product "ZZ"/);
    assert.throws(() => buildGenerateRequest({ context: null, assets: [], files: [], slots: [] }, { slot: 's' }), /no applied kit/);
    assert.equal(parseFactValue('49.5'), 49.5);
    assert.equal(parseFactValue('Calvessa'), 'Calvessa');
    assert.equal(parseFactValue('[oops'), '[oops');
    assert.deepEqual(setPath({ a: 1 }, 'b.c', 2), { a: 1, b: { c: 2 } });
});

test('syncDrive uploads images as assets and documents as files with source=drive, skips ones already there, saves the manifest', async () => {
    const mock = await startMock();
    try {
        const html = (entries: Array<[string, string, string]>) => {
            const data = JSON.stringify([entries.map(([id, name, mime]) => [id, [], name, mime])]).replace(/\\/g, '\\\\').replace(/"/g, '\\x22');
            return `<title>Kit - Google Drive</title><script>window['_DRIVE_ivd'] = '${data}';</script>`;
        };
        const routes: Record<string, [string, Buffer]> = {
            'https://drive.google.com/drive/folders/FOLDERid0001': ['text/html', Buffer.from(html([
                ['drv1', 'Bottle.png', 'image/png'], ['drv2', 'Label.webp', 'image/webp'], ['drv3', 'Brief', 'application/vnd.google-apps.document'], ['drv4', 'clip.mov', 'video/quicktime'],
            ]))],
            'https://drive.usercontent.google.com/download?id=drv2&export=download&confirm=t': ['image/webp', Buffer.from('WEBP')],
            'https://docs.google.com/document/d/drv3/export?format=markdown': ['text/markdown', Buffer.from('# Brief\n')],
        };
        const get: HttpGet = async (u) => {
            const hit = routes[u];
            const body = hit ? hit[1] : Buffer.from('nope');
            return { status: hit ? 200 : 404, body, headers: { get: (n) => (n === 'content-type' ? (hit ? hit[0] : 'text/html') : n === 'content-length' ? String(body.length) : null) } };
        };
        const api = new ApiClient(mock.url, 'secret-key');
        const r = await syncDrive(api, 7, { url: 'https://drive.google.com/drive/folders/FOLDERid0001', get });
        assert.equal(r.code, 0, JSON.stringify(r));
        assert.deepEqual(r.alreadyThere, ['Bottle.png']);
        assert.deepEqual(r.uploaded.map((u) => [u.name, u.as]), [['Label.webp', 'asset'], ['Brief.md', 'file']]);
        const label = mock.state.assets.find((a) => a.drive_file_id === 'drv2')!;
        assert.equal(label.source, 'drive');
        const brief = mock.state.files.find((f) => f.drive_file_id === 'drv3')!;
        assert.equal(brief.converted_md, '# Brief\n');
        assert.equal(mock.state.context.drive_url, 'https://drive.google.com/drive/folders/FOLDERid0001');
        const manifest = (mock.state.context as unknown as { drive_manifest: { skipped: Array<{ name: string }>; exitCode: number } }).drive_manifest;
        assert.deepEqual(manifest.skipped.map((s) => s.name), ['clip.mov']);
        assert.equal(manifest.exitCode, 0);

        // No link anywhere: a clear error, nothing fetched.
        mock.state.context.drive_url = null;
        const none = await syncDrive(api, 7, { get });
        assert.equal(none.code, 1);
        assert.match(none.error!, /No Drive link/);
    } finally {
        await mock.close();
    }
});

test('pullKitContext works with a bearer runner credential and an injected downloader', async () => {
    const mock = await startMock();
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-ws-'));
        const seen: string[] = [];
        const r = await pullKitContext(dir, new ApiClient(mock.url, 'agent-token', { scheme: 'bearer', runnerId: 'r1' }), 7, { fetchBytes: async (u) => { seen.push(u); return new Uint8Array(Buffer.from(u.endsWith('.pdf') ? '%PDF-brief' : 'PACKSHOT-1')); } });
        assert.equal(r.blockers.length, 1);
        assert.equal(seen.length, 2);
        const q = mock.requests.find((x) => x.url === '/api/brands/7/ai-context')!;
        assert.equal(q.headers.authorization, 'Bearer agent-token');
        assert.equal(q.headers['x-runner-id'], 'r1');
        assert.ok(fs.existsSync(path.join(dir, '.ef', 'context', 'kit.json')));
    } finally {
        await mock.close();
    }
});

test('convertPendingBriefs converts .docx brief files without converted_md and saves the Markdown back', async () => {
    const mock = await startMock();
    try {
        mock.blobs['/cdn/claims.docx'] = sampleDocx();
        mock.state.files.push({ id: 4, name: 'Claims.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url: `${mock.url}/cdn/claims.docx`, sha256: null, converted_md: null, drive_file_id: null });
        const r = await convertPendingBriefs(new ApiClient(mock.url, 'k'), 7);
        assert.deepEqual(r, { converted: ['Claims.docx'], failed: [] });
        assert.match(String(mock.state.files.find((f) => f.id === 4)!.converted_md), /^# Calvessa Brief/);
        const again = await convertPendingBriefs(new ApiClient(mock.url, 'k'), 7);
        assert.deepEqual(again.converted, []);
    } finally {
        await mock.close();
    }
});
