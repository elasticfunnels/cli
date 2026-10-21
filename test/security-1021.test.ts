import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { ApiClient } from '../src/api/client';
import { ZipReader, docxBytesToMarkdown } from '../src/lib/docx2md';
import { assertDriveUrl, downloadBinary, driveFetch, makeHttpGet, type HttpGet, type HttpResponse } from '../src/lib/driveFetch';
import { formatMissing, pullKitContext } from '../src/lib/kitContext';
import { setPath } from '../src/commands/context';
import { parseMaxCredits } from '../src/commands/images';
import { makeZip, sampleDocx } from './helpers/zipWriter';

/** Security review 2026-10-20 (commit f3ae434): Drive SSRF, context symlinks, docx zip bomb, credit cap, terminal output, fact keys. */

function res(status: number, body: string | Buffer, type = 'application/octet-stream', extra: Record<string, string> = {}): HttpResponse {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const h: Record<string, string> = { 'content-type': type, 'content-length': String(b.length), ...extra };
    return { status, body: b, headers: { get: (n: string) => h[n.toLowerCase()] ?? null } };
}

// ── 1. Drive SSRF ─────────────────────────────────────────────────────

test('assertDriveUrl: https Google Drive hosts only; googleusercontent only as a redirect hop', () => {
    for (const ok of ['https://drive.usercontent.google.com/download', 'https://drive.google.com/x', 'https://docs.google.com/document/d/1/export']) assertDriveUrl(ok);
    assertDriveUrl('https://doc-0s-1c-docs.googleusercontent.com/x', { redirect: true });
    for (const bad of [
        'http://drive.usercontent.google.com/download',
        'https://169.254.169.254/latest/meta-data/',
        'https://localhost/x',
        'https://drive.google.com.evil.example/x',
        'https://user:pw@drive.google.com/x',
        'https://drive.google.com:8443/x',
        'file:///etc/passwd',
        'https://doc-0s.googleusercontent.com/x',
    ]) assert.throws(() => assertDriveUrl(bad), /refusing/, bad);
});

test('downloadBinary: a planted confirm form pointing off Drive is never fetched', async () => {
    const calls: string[] = [];
    const get: HttpGet = async (url) => {
        calls.push(url);
        if (url.includes('id=evil0000001')) return res(200, '<html><form action="http://169.254.169.254/latest/meta-data/"><input type="hidden" name="id" value="x"></form></html>', 'text/html');
        return res(200, 'SECRET');
    };
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ef-sec-')), 'a.png');
    await assert.rejects(downloadBinary(get, 'evil0000001', dest), /refusing to fetch http:/);
    assert.equal(calls.length, 1);
    assert.ok(!fs.existsSync(dest));
    await assert.rejects(downloadBinary(get, '../../x?y', dest), /not a Drive id/);
});

function fakeFetch(routes: Record<string, () => Response>) {
    const seen: Array<{ url: string; cookie: string | null; redirect: string | undefined }> = [];
    const f = async (url: string, init: RequestInit) => {
        seen.push({ url, cookie: new Headers(init.headers).get('cookie'), redirect: init.redirect });
        const r = routes[url];
        return r ? r() : new Response('nope', { status: 404 });
    };
    return { f, seen };
}

test('makeHttpGet: redirects followed by hand and checked per hop; cookies stay with their host; body capped while streaming', async () => {
    const { f, seen } = fakeFetch({
        'https://drive.google.com/a': () => new Response(null, { status: 302, headers: { location: 'https://drive.usercontent.google.com/b', 'set-cookie': 'SID=drive-google; Path=/' } }),
        'https://drive.usercontent.google.com/b': () => new Response('ok', { status: 200, headers: { 'set-cookie': 'NID=usercontent' } }),
        'https://drive.usercontent.google.com/c': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } }),
        'https://docs.google.com/big': () => new Response(new ReadableStream({
            start(ctl) { for (let i = 0; i < 5; i++) ctl.enqueue(new Uint8Array(400)); ctl.close(); },
        }), { status: 200 }),
    });
    const get = makeHttpGet(f as never, 1000);
    const r = await get('https://drive.google.com/a');
    assert.equal(r.body.toString(), 'ok');
    assert.ok(seen.every((s) => s.redirect === 'manual'));
    assert.equal(seen[1].cookie, null, 'drive.google.com cookie not sent to drive.usercontent.google.com');
    await get('https://drive.usercontent.google.com/b');
    assert.equal(seen[2].cookie, 'NID=usercontent');

    await assert.rejects(get('https://drive.usercontent.google.com/c'), /refusing to fetch http:\/\/127\.0\.0\.1/);
    assert.ok(!seen.some((s) => s.url.includes('127.0.0.1')));
    await assert.rejects(get('https://docs.google.com/big'), /over the 1000 byte limit/);
    await assert.rejects(get('https://evil.example/x'), /refusing/);
});

// ── 2. context pull and symlinks ──────────────────────────────────────

function startApi(base: () => string) {
    const assets = [{ id: 21, name: 'Bottle.png', url: '', kind: 'product', sha256: null }];
    const server = http.createServer((req, res) => {
        const url = (req.url || '').split('?')[0];
        const json = (p: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
        if (url === '/api/brands/7/ai-context') return json({ context: null, assets: assets.map((a) => ({ ...a, url: `${base()}/cdn/a.png` })), files: [], slots: [] });
        if (url === '/api/brands/7/ai-context/missing') return json({ data: [] });
        res.writeHead(404); res.end();
    });
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    }));
}

test('pullKitContext: refuses a symlinked assets dir or context file, and cleanup only deletes regular files', async () => {
    let base = '';
    const api = await startApi(() => base);
    base = api.url;
    const fetchBytes = async () => new Uint8Array(Buffer.from('PNG'));
    try {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-outside-'));
        fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-proj-'));
        fs.mkdirSync(path.join(root, '.ef', 'context'), { recursive: true });
        fs.symlinkSync(outside, path.join(root, '.ef', 'context', 'assets'));
        await assert.rejects(pullKitContext(root, new ApiClient(api.url, 'k'), 7, { fetchBytes }), /symlink/);
        assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');

        const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-proj-'));
        fs.mkdirSync(path.join(root2, '.ef'), { recursive: true });
        fs.symlinkSync(outside, path.join(root2, '.ef', 'context'));
        await assert.rejects(pullKitContext(root2, new ApiClient(api.url, 'k'), 7, { fetchBytes }), /symlink/);

        const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-proj-'));
        fs.mkdirSync(path.join(root3, '.ef', 'context', 'assets', 'subdir'), { recursive: true });
        fs.writeFileSync(path.join(root3, '.ef', 'context', 'assets', 'stale.png'), 'old');
        fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(root3, '.ef', 'context', 'assets', 'link.txt'));
        fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(root3, '.ef', 'context', 'kit.json'));
        await assert.rejects(pullKitContext(root3, new ApiClient(api.url, 'k'), 7, { fetchBytes }), /kit\.json is a symlink/);
        assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
        fs.unlinkSync(path.join(root3, '.ef', 'context', 'kit.json'));
        const r = await pullKitContext(root3, new ApiClient(api.url, 'k'), 7, { fetchBytes });
        assert.ok(!fs.existsSync(path.join(root3, '.ef', 'context', 'assets', 'stale.png')), 'a stale regular file is removed');
        assert.deepEqual(r.removed, []);
        assert.ok(fs.existsSync(path.join(root3, '.ef', 'context', 'assets', 'subdir')), 'directories are never removed');
        assert.ok(fs.lstatSync(path.join(root3, '.ef', 'context', 'assets', 'link.txt')).isSymbolicLink());
        assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
        assert.deepEqual(r.downloaded, ['a21-Bottle.png']);
    } finally {
        await api.close();
    }
});

// ── 3. docx zip bomb ──────────────────────────────────────────────────

test('ZipReader: entry count, declared size and the real inflate are all capped', () => {
    const big = makeZip({ 'word/document.xml': Buffer.alloc(5000) });
    assert.throws(() => new ZipReader(big, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 10_000 }), /over the 1000 limit/);
    assert.throws(() => new ZipReader(makeZip({ a: 'x', b: 'y', c: 'z' }), { maxEntries: 2, maxEntryBytes: 1000, maxTotalBytes: 10_000 }), /3 entries/);
    assert.throws(() => new ZipReader(makeZip({ a: Buffer.alloc(800), b: Buffer.alloc(800) }), { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1000 }), /more than 1000 bytes/);

    // A header that understates the size: the inflate itself stops at the declared size.
    const lying = makeZip({ 'word/document.xml': Buffer.alloc(5000) });
    const cd = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lying.writeUInt32LE(10, cd + 24);
    const z = new ZipReader(lying);
    assert.throws(() => z.read('word/document.xml'), /more than its declared size/);
    assert.throws(() => docxBytesToMarkdown(lying), /more than its declared size/);

    assert.match(docxBytesToMarkdown(sampleDocx()), /^# Calvessa Brief/);
});

// ── 4. credit cap ─────────────────────────────────────────────────────

test('parseMaxCredits accepts whole numbers only', () => {
    assert.equal(parseMaxCredits('0'), 0);
    assert.equal(parseMaxCredits(' 150 '), 150);
    for (const bad of ['abc', '', '-1', '1.5', '1e3', 'NaN', '99999999999999999999']) assert.throws(() => parseMaxCredits(bad), /whole number/, bad);
});

// ── 5. terminal output ────────────────────────────────────────────────

test('Drive names and missing rows reach the terminal without escapes or line breaks', async () => {
    const ESC = '\u001b';
    const evil = `x${ESC}]52;c;cGF5bG9hZA==\u0007\n${ESC}[32m✓ fake.exe`;
    const data = JSON.stringify([[['exe00000001', ['p'], evil, 'application/octet-stream'], ['img00000001', ['p'], `ok${ESC}[2J.png`, 'image/png']]]);
    const escaped = data.replace(/\\/g, '\\\\').replace(/"/g, '\\x22').replace(/'/g, "\\'");
    const page = `<html><title>T${ESC}[31m - Google Drive</title><script>window['_DRIVE_ivd'] = '${escaped}';</script></html>`;
    const get: HttpGet = async (url) => (url.includes('/folders/') ? res(200, page, 'text/html') : res(404, 'no', 'text/html'));
    const lines: string[] = [];
    const r = await driveFetch('ROOTfolder01', { out: fs.mkdtempSync(path.join(os.tmpdir(), 'ef-sec-')), get, log: (l) => lines.push(l) });
    for (const l of [...r.notes, ...lines]) {
        assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(l), JSON.stringify(l));
    }
    assert.ok(r.notes.some((n) => n.startsWith('skipped ')));

    const out = formatMissing([{ kind: `k${ESC}[2J`, key: 'x', label: `L\n${ESC}[32mok`, pages: [`p${ESC}]8;;http://x\u0007`], fix: `f\r`, blocking: true } as never]);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(out[0]), JSON.stringify(out[0]));
});

// ── 6. fact keys ──────────────────────────────────────────────────────

test('setPath refuses __proto__ / prototype / constructor and never touches Object.prototype', () => {
    for (const k of ['__proto__.polluted', 'a.__proto__.polluted', 'constructor.prototype.polluted', 'prototype']) {
        assert.throws(() => setPath({}, k, 1), /cannot be part of a fact key/, k);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(setPath({ a: { b: 1 } }, 'a.c', 2), { a: { b: 1, c: 2 } });
});
