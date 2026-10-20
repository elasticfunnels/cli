import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { convertDocx, docxBytesToMarkdown, parseXml } from '../src/lib/docx2md';
import { driveFetch, folderId, jsUnescape, type HttpGet, type HttpResponse } from '../src/lib/driveFetch';
import { sampleDocx } from './helpers/zipWriter';

/**
 * Port of launch-accelerator lib/drive_fetch.py + docx2md.py: the Drive listing blob, exports,
 * docx conversion, the allow-list (skipped, not failed), and exit codes 0 / 1 / 2.
 */

test('docx2md: headings, bold/italic, links, lists, tables, images, entities', () => {
    const md = docxBytesToMarkdown(sampleDocx());
    assert.match(md, /^# Calvessa Brief\n\n## Offer\n/);
    assert.match(md, /\*\*Price:\*\* \$49 & free shipping \*today\*/);
    assert.match(md, /\[See site\]\(https:\/\/example\.com\/x\)/);
    assert.match(md, /- Bullet one\n {2}- Nested \\\*star\\\*\n1\. Step one/);
    assert.match(md, /\| Pack \| Price \|\n\| --- \| --- \|\n\| 3 \\\| bottles \| \$129 \|/);
    assert.match(md, /!\[image1\.png\]\(image1\.png\)/);
    assert.match(md, /> Café quote/);
});

test('docx2md convert writes the .md and the media folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-docx-'));
    const src = path.join(dir, 'brief.docx');
    fs.writeFileSync(src, sampleDocx());
    const r = convertDocx(src, path.join(dir, 'brief.md'));
    assert.deepEqual(r.images, ['image1.png']);
    assert.ok(fs.existsSync(path.join(dir, 'brief.media', 'image1.png')));
    assert.match(fs.readFileSync(path.join(dir, 'brief.md'), 'utf8'), /!\[image1\.png\]\(brief\.media\/image1\.png\)/);
});

test('xml reader resolves namespaces and CDATA', () => {
    const n = parseXml('<?xml version="1.0"?><a xmlns="urn:x" xmlns:p="urn:p"><p:b p:k="1 &lt; 2"><![CDATA[<raw>]]></p:b><c/></a>');
    assert.equal(n.tag, '{urn:x}a');
    assert.equal(n.children[0].tag, '{urn:p}b');
    assert.equal(n.children[0].attrs['{urn:p}k'], '1 < 2');
    assert.equal(n.children[0].text, '<raw>');
    assert.equal(n.children[1].tag, '{urn:x}c');
});

test('folderId and jsUnescape', () => {
    assert.equal(folderId('https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing'), '1AbCdEfGhIjK');
    assert.equal(folderId('https://drive.google.com/open?id=1AbCdEfGhIjK'), '1AbCdEfGhIjK');
    assert.equal(folderId('1AbCdEfGhIjK'), '1AbCdEfGhIjK');
    assert.throws(() => folderId('nope'));
    assert.equal(jsUnescape('a\\x22b\\u00e9\\/\\n\\ud83d\\ude00'), 'a"bé/\n😀');
});

// ── fake Drive ───────────────────────────────────────────────────────

function res(status: number, body: string | Buffer, type = 'application/octet-stream', length?: number): HttpResponse {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const h: Record<string, string> = { 'content-type': type, 'content-length': String(length ?? b.length) };
    return { status, body: b, headers: { get: (n: string) => h[n.toLowerCase()] ?? null } };
}

/** A folder page with the listing in window['_DRIVE_ivd'], escaped the way Drive does it. */
function folderPage(title: string, entries: Array<[string, string, string]>): string {
    const data = JSON.stringify([entries.map(([id, name, mime]) => [id, ['parent'], name, mime])]);
    const escaped = data.replace(/\\/g, '\\\\').replace(/"/g, '\\x22').replace(/'/g, "\\'");
    return `<html><title>${title} - Google Drive</title><script>window['_DRIVE_ivd'] = '${escaped}';</script></html>`;
}

const ROOT = 'ROOTfolder01';
function fakeDrive(overrides: Record<string, HttpResponse> = {}): { get: HttpGet; calls: string[] } {
    const calls: string[] = [];
    const routes: Record<string, HttpResponse> = {
        [`https://drive.google.com/drive/folders/${ROOT}`]: res(200, folderPage('Calvessa assets', [
            ['img00000001', 'Bottle front.png', 'image/png'],
            ['doc00000001', 'Brief', 'application/vnd.google-apps.document'],
            ['sht00000001', 'Prices', 'application/vnd.google-apps.spreadsheet'],
            ['dcx00000001', 'Claims.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
            ['exe00000001', 'setup.exe', 'application/octet-stream'],
            ['vid00000001', 'ad.mp4', 'video/mp4'],
            ['sub00000001', 'Labels', 'application/vnd.google-apps.folder'],
        ]), 'text/html'),
        'https://drive.google.com/drive/folders/sub00000001': res(200, folderPage('Labels', [
            ['lbl00000001', 'Label.jpg', 'image/jpeg'],
            ['shc00000001', 'Link to x', 'application/vnd.google-apps.shortcut'],
        ]), 'text/html'),
        'https://drive.usercontent.google.com/download?id=img00000001&export=download&confirm=t': res(200, Buffer.from('PNGDATA')),
        'https://drive.usercontent.google.com/download?id=lbl00000001&export=download&confirm=t': res(200, '<html>virus scan<form action="https://drive.usercontent.google.com/download"><input type="hidden" name="id" value="lbl00000001"><input type="hidden" name="uuid" value="u1"></form></html>', 'text/html'),
        'https://drive.usercontent.google.com/download?id=lbl00000001&uuid=u1&confirm=t': res(200, Buffer.from('JPEGDATA')),
        'https://drive.usercontent.google.com/download?id=dcx00000001&export=download&confirm=t': res(200, sampleDocx()),
        'https://docs.google.com/document/d/doc00000001/export?format=markdown': res(200, '# Brief\n\nCalvessa chews.\n', 'text/markdown'),
        'https://docs.google.com/spreadsheets/d/sht00000001/export?format=csv': res(200, 'pack,price\n1,49\n', 'text/csv'),
        ...overrides,
    };
    return {
        calls,
        get: async (url) => {
            calls.push(url);
            return routes[url] ?? res(404, 'not found', 'text/html');
        },
    };
}

test('driveFetch: exports, converts docx, recurses, follows the confirm form, skips disallowed types; shortcut makes it incomplete (2)', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-drive-'));
    const { get, calls } = fakeDrive();
    const r = await driveFetch(`https://drive.google.com/drive/folders/${ROOT}`, { out, get });
    assert.equal(r.code, 2, JSON.stringify(r.notes));
    const m = r.manifest!;
    assert.equal(m.source.title, 'Calvessa assets');
    const byPath = Object.fromEntries(m.files.map((f) => [f.path, f]));
    assert.equal(byPath['Bottle front.png'].kind, 'binary');
    assert.equal(byPath['Brief.md'].kind, 'exported');
    assert.equal(byPath['Prices.csv'].caveat?.startsWith('CSV export covers the first sheet only'), true);
    assert.equal(byPath['Claims.md'].kind, 'converted');
    assert.deepEqual(byPath['Claims.md'].media, ['Claims.media/image1.png']);
    assert.equal(byPath['Labels/Label.jpg'].kind, 'binary');
    assert.equal(fs.readFileSync(path.join(out, 'Labels', 'Label.jpg'), 'utf8'), 'JPEGDATA');
    assert.ok(!fs.existsSync(path.join(out, 'Claims.docx')), 'no .docx is ever left on disk');
    assert.deepEqual(m.skipped.map((s) => s.name).sort(), ['ad.mp4', 'setup.exe']);
    assert.ok(!calls.some((u) => u.includes('exe00000001') || u.includes('vid00000001')), 'skipped files are never downloaded');
    assert.equal(m.failures.length, 1);
    assert.match(m.failures[0].error, /a shortcut, not a file/);
    assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
});

test('driveFetch: a clean folder exits 0; a private folder exits 1 with the sharing explanation; a truncated file fails', async () => {
    const clean = fakeDrive({
        [`https://drive.google.com/drive/folders/${ROOT}`]: res(200, folderPage('Clean', [['img00000001', 'a.png', 'image/png']]), 'text/html'),
    });
    const ok = await driveFetch(ROOT, { out: fs.mkdtempSync(path.join(os.tmpdir(), 'ef-drive-')), get: clean.get });
    assert.equal(ok.code, 0);

    const priv = await driveFetch('PRIVATEfolder1', { out: fs.mkdtempSync(path.join(os.tmpdir(), 'ef-drive-')), get: fakeDrive().get });
    assert.equal(priv.code, 1);
    assert.match(priv.error!, /Anyone with the link/);

    const short = fakeDrive({
        [`https://drive.google.com/drive/folders/${ROOT}`]: res(200, folderPage('Short', [['img00000001', 'a.png', 'image/png']]), 'text/html'),
        'https://drive.usercontent.google.com/download?id=img00000001&export=download&confirm=t': res(200, Buffer.from('abc'), 'image/png', 10),
    });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-drive-'));
    const t = await driveFetch(ROOT, { out, get: short.get });
    assert.equal(t.code, 2);
    assert.match(t.manifest!.failures[0].error, /truncated download/);
    assert.ok(!fs.existsSync(path.join(out, 'a.png')) && !fs.existsSync(path.join(out, 'a.png.part')));

    const empty = fakeDrive({ [`https://drive.google.com/drive/folders/${ROOT}`]: res(200, folderPage('Empty', []), 'text/html') });
    assert.equal((await driveFetch(ROOT, { out: fs.mkdtempSync(path.join(os.tmpdir(), 'ef-drive-')), get: empty.get })).code, 2);
});
