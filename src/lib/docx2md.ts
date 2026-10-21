// .docx -> GitHub-flavoured Markdown with no dependencies.
//
// Port of ~/Work/elasticfunnels-launch-accelerator/lib/docx2md.py. No pandoc on the runner
// box, so this implements just enough WordprocessingML for what vendor briefs carry:
// headings, lists, tables, bold/italic, hyperlinks and embedded images. A .docx is a zip;
// the zip reader and the XML reader below are the minimum for that.
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

// ── zip ──────────────────────────────────────────────────────────────

/** Limits for an untrusted .docx: a small zip must not expand into gigabytes (zip bomb). */
export const ZIP_LIMITS = {
    maxEntries: 5000,
    /** Uncompressed bytes for one entry (document.xml, one embedded image). */
    maxEntryBytes: 64 * 1024 * 1024,
    /** Uncompressed bytes for the whole archive, declared and actually inflated. */
    maxTotalBytes: 256 * 1024 * 1024,
};

export class ZipReader {
    private entries = new Map<string, { method: number; compSize: number; size: number; localOffset: number }>();
    private inflated = 0;

    constructor(private readonly buf: Buffer, private readonly limits = ZIP_LIMITS) {
        // End of central directory: last 22..65557 bytes.
        let eocd = -1;
        for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
            if (buf.readUInt32LE(i) === 0x06054b50) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
        const count = buf.readUInt16LE(eocd + 10);
        if (count > limits.maxEntries) throw new Error(`zip has ${count} entries, over the ${limits.maxEntries} limit`);
        let declared = 0;
        let p = buf.readUInt32LE(eocd + 16);
        for (let n = 0; n < count; n++) {
            if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
            const method = buf.readUInt16LE(p + 10);
            const compSize = buf.readUInt32LE(p + 20);
            const size = buf.readUInt32LE(p + 24);
            const nameLen = buf.readUInt16LE(p + 28);
            const extraLen = buf.readUInt16LE(p + 30);
            const commentLen = buf.readUInt16LE(p + 32);
            const localOffset = buf.readUInt32LE(p + 42);
            const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
            if (size > limits.maxEntryBytes) throw new Error(`zip entry ${name} unpacks to ${size} bytes, over the ${limits.maxEntryBytes} limit`);
            declared += size;
            if (declared > limits.maxTotalBytes) throw new Error(`zip unpacks to more than ${limits.maxTotalBytes} bytes`);
            this.entries.set(name, { method, compSize, size, localOffset });
            p += 46 + nameLen + extraLen + commentLen;
        }
    }

    names(): string[] {
        return [...this.entries.keys()];
    }

    read(name: string): Buffer | null {
        const e = this.entries.get(name);
        if (!e) return null;
        const p = e.localOffset;
        if (p + 30 > this.buf.length || this.buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`);
        const start = p + 30 + this.buf.readUInt16LE(p + 26) + this.buf.readUInt16LE(p + 28);
        const data = this.buf.subarray(start, start + e.compSize);
        let out: Buffer;
        if (e.method === 0) {
            out = Buffer.from(data);
        } else if (e.method === 8) {
            // The declared size is the header's word; the real inflate is capped too, so a
            // header that lies about the size cannot get more than the limits allow.
            const room = Math.min(this.limits.maxEntryBytes, this.limits.maxTotalBytes - this.inflated);
            try {
                out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(room, e.size || room)) });
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
                    throw new Error(`zip entry ${name} unpacks to more than its declared size or the size limit`);
                }
                throw err;
            }
        } else {
            throw new Error(`unsupported zip compression ${e.method} for ${name}`);
        }
        this.inflated += out.length;
        if (this.inflated > this.limits.maxTotalBytes) throw new Error(`zip unpacks to more than ${this.limits.maxTotalBytes} bytes`);
        return out;
    }
}

// ── xml ──────────────────────────────────────────────────────────────

export interface XNode {
    /** `{namespace}local`, like ElementTree. */
    tag: string;
    attrs: Record<string, string>;
    children: XNode[];
    /** Text directly inside this element (all text runs, joined). */
    text: string;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
            const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return ENT[e] ?? m;
    });

/** Parse XML into a namespace-resolved tree. Enough for OOXML parts; not a validating parser. */
export function parseXml(src: string): XNode {
    const root: XNode = { tag: '#root', attrs: {}, children: [], text: '' };
    const stack: Array<{ node: XNode; ns: Record<string, string> }> = [{ node: root, ns: {} }];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const resolve = (qname: string, ns: Record<string, string>, isAttr: boolean): string => {
        const i = qname.indexOf(':');
        if (i < 0) return isAttr ? qname : ns[''] ? `{${ns['']}}${qname}` : qname;
        const pre = qname.slice(0, i);
        const uri = ns[pre];
        return uri ? `{${uri}}${qname.slice(i + 1)}` : qname;
    };
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) {
            top.node.text += m[1];
        } else if (m[2] !== undefined) {
            if (stack.length > 1) stack.pop();
        } else if (m[3] !== undefined) {
            const rawAttrs: Array<[string, string]> = [];
            const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
            let a: RegExpExecArray | null;
            while ((a = ar.exec(m[4] || ''))) rawAttrs.push([a[1], decode(a[2] ?? a[3] ?? '')]);
            const ns = { ...top.ns };
            for (const [k, v] of rawAttrs) {
                if (k === 'xmlns') ns[''] = v;
                else if (k.startsWith('xmlns:')) ns[k.slice(6)] = v;
            }
            const attrs: Record<string, string> = {};
            for (const [k, v] of rawAttrs) if (k !== 'xmlns' && !k.startsWith('xmlns:')) attrs[resolve(k, ns, true)] = v;
            const node: XNode = { tag: resolve(m[3], ns, false), attrs, children: [], text: '' };
            top.node.children.push(node);
            if (!m[5]) stack.push({ node, ns });
        } else if (m[6] !== undefined) {
            top.node.text += decode(m[6]);
        }
    }
    const el = root.children[0];
    if (!el) throw new Error('empty XML document');
    return el;
}

function* iter(n: XNode): Generator<XNode> {
    yield n;
    for (const c of n.children) yield* iter(c);
}

// ── docx ─────────────────────────────────────────────────────────────

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const w = (t: string) => `{${W}}${t}`;
const find = (n: XNode, tag: string) => n.children.find((c) => c.tag === tag);
const findAll = (n: XNode, tag: string) => n.children.filter((c) => c.tag === tag);

/** Escape only what can start inline markup: over-escaping mangles copy a model reads later. */
export const esc = (t: string) => t.replace(/([\\`*_[\]])/g, '\\$1');

type Seg = [string, boolean, boolean];

export class Docx {
    private rels: Record<string, [string, string]>;
    private numbering: Record<string, Record<number, string>>;

    constructor(private readonly zip: ZipReader) {
        this.rels = this.loadRels();
        this.numbering = this.loadNumbering();
    }

    static fromFile(p: string): Docx {
        return new Docx(new ZipReader(fs.readFileSync(p)));
    }

    private xml(name: string): XNode | null {
        const b = this.zip.read(name);
        return b ? parseXml(b.toString('utf8')) : null;
    }

    private loadRels(): Record<string, [string, string]> {
        const root = this.xml('word/_rels/document.xml.rels');
        const out: Record<string, [string, string]> = {};
        if (!root) return out;
        for (const rel of findAll(root, `{${REL}}Relationship`)) {
            const id = rel.attrs.Id;
            if (id) out[id] = [rel.attrs.Target ?? '', rel.attrs.Type ?? ''];
        }
        return out;
    }

    private loadNumbering(): Record<string, Record<number, string>> {
        const root = this.xml('word/numbering.xml');
        if (!root) return {};
        const abstract: Record<string, Record<number, string>> = {};
        for (const an of findAll(root, w('abstractNum'))) {
            const aid = an.attrs[w('abstractNumId')];
            if (aid === undefined) continue;
            const levels: Record<number, string> = {};
            for (const lvl of findAll(an, w('lvl'))) {
                const ilvl = parseInt(lvl.attrs[w('ilvl')] ?? '0', 10);
                if (!Number.isFinite(ilvl)) continue;
                const fmt = find(lvl, w('numFmt'));
                levels[ilvl] = fmt ? fmt.attrs[w('val')] ?? 'bullet' : 'bullet';
            }
            abstract[aid] = levels;
        }
        const out: Record<string, Record<number, string>> = {};
        for (const num of findAll(root, w('num'))) {
            const nid = num.attrs[w('numId')];
            const ref = find(num, w('abstractNumId'));
            if (nid && ref) out[nid] = abstract[ref.attrs[w('val')] ?? ''] ?? {};
        }
        return out;
    }

    private runSegments(node: XNode, images: string[]): Seg[] {
        const segs: Seg[] = [];
        for (const child of node.children) {
            if (child.tag === w('hyperlink')) {
                const inner = this.runSegments(child, images);
                const text = inner.map((s) => s[0]).join('').trim();
                const rid = child.attrs[`{${R}}id`];
                const target = rid ? this.rels[rid]?.[0] ?? '' : '';
                if (text && target) segs.push([`[${esc(text)}](${target})`, false, false]);
                else if (text) segs.push([esc(text), false, false]);
                continue;
            }
            if (child.tag !== w('r')) continue;
            const props = find(child, w('rPr'));
            let bold = false;
            let italic = false;
            if (props) {
                const b = find(props, w('b'));
                const i = find(props, w('i'));
                const on = (x?: XNode) => !!x && !['0', 'false'].includes(x.attrs[w('val')] ?? 'true');
                bold = on(b);
                italic = on(i);
            }
            for (const part of child.children) {
                if (part.tag === w('t')) {
                    if (part.text) segs.push([esc(part.text), bold, italic]);
                } else if (part.tag === w('tab')) {
                    segs.push(['  ', false, false]);
                } else if (part.tag === w('br') || part.tag === w('cr')) {
                    segs.push(['\n', false, false]);
                } else if (part.tag === w('drawing')) {
                    const ref = this.imageRef(part, images);
                    if (ref) segs.push([ref, false, false]);
                }
            }
        }
        return segs;
    }

    private imageRef(drawing: XNode, images: string[]): string {
        for (const el of iter(drawing)) {
            const rid = el.attrs[`{${R}}embed`] || el.attrs[`{${R}}link`];
            if (!rid) continue;
            const target = this.rels[rid]?.[0] ?? '';
            if (!target) continue;
            const name = path.posix.basename(target);
            if (!images.includes(name)) images.push(name);
            return `![${esc(name)}](@@MEDIA@@/${name})`;
        }
        return '';
    }

    /** Merge adjacent same-formatted segments so we emit **ab**, not **a****b**. */
    static render(segs: Seg[]): string {
        const merged: Seg[] = [];
        for (const [text, bold, italic] of segs) {
            const last = merged[merged.length - 1];
            if (last && last[1] === bold && last[2] === italic) last[0] += text;
            else merged.push([text, bold, italic]);
        }
        let out = '';
        for (const [text, bold, italic] of merged) {
            if (!text) continue;
            const stripped = text.trim();
            if (!stripped) {
                out += text;
                continue;
            }
            const lead = text.slice(0, text.length - text.trimStart().length);
            const trail = text.slice(text.trimEnd().length);
            const marker = bold && italic ? '***' : bold ? '**' : italic ? '*' : '';
            out += `${lead}${marker}${stripped}${marker}${trail}`;
        }
        return out;
    }

    private paragraph(node: XNode, images: string[]): string {
        const props = find(node, w('pPr'));
        let style = '';
        let indent = 0;
        let listFmt: 'ordered' | 'bullet' | null = null;
        if (props) {
            const st = find(props, w('pStyle'));
            if (st) style = st.attrs[w('val')] ?? '';
            const num = find(props, w('numPr'));
            if (num) {
                const ilvlEl = find(num, w('ilvl'));
                const numIdEl = find(num, w('numId'));
                const ilvl = ilvlEl ? parseInt(ilvlEl.attrs[w('val')] ?? '0', 10) || 0 : 0;
                const numId = numIdEl ? numIdEl.attrs[w('val')] ?? '' : '';
                const fmt = this.numbering[numId]?.[ilvl] ?? 'bullet';
                listFmt = fmt !== 'bullet' && fmt !== 'none' ? 'ordered' : 'bullet';
                indent = ilvl;
            }
        }
        const text = Docx.render(this.runSegments(node, images));
        if (!text.trim()) return '';
        if (listFmt) return `${'  '.repeat(indent)}${listFmt === 'ordered' ? '1.' : '-'} ${text}`;
        const h = /^Heading(\d+)$/.exec(style);
        if (h) return `${'#'.repeat(Math.min(parseInt(h[1], 10), 6))} ${text}`;
        if (style === 'Title') return `# ${text}`;
        if (style === 'Subtitle') return `## ${text}`;
        if (style === 'Quote' || style === 'IntenseQuote') return `> ${text}`;
        return text;
    }

    private table(node: XNode, images: string[]): string {
        let rows: string[][] = [];
        for (const tr of findAll(node, w('tr'))) {
            const cells: string[] = [];
            for (const tc of findAll(tr, w('tc'))) {
                const parts = findAll(tc, w('p')).map((p) => Docx.render(this.runSegments(p, images)));
                cells.push(parts.filter(Boolean).join(' ').replace(/\|/g, '\\|').trim());
            }
            if (cells.length) rows.push(cells);
        }
        if (!rows.length) return '';
        const width = Math.max(...rows.map((r) => r.length));
        rows = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
        const body = rows.slice(1);
        const head = rows[0].some(Boolean) ? rows[0] : rows[0].map((_, i) => `Col ${i + 1}`);
        return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
    }

    toMarkdown(): { markdown: string; images: string[] } {
        const root = this.xml('word/document.xml');
        if (!root) throw new Error('no word/document.xml: not a valid .docx');
        const body = find(root, w('body'));
        if (!body) throw new Error('no document body');
        const images: string[] = [];
        const blocks: string[] = [];
        for (const node of body.children) {
            if (node.tag === w('p')) blocks.push(this.paragraph(node, images));
            else if (node.tag === w('tbl')) blocks.push(this.table(node, images));
        }
        const out: string[] = [];
        const isItem = (s: string) => /^(- |1\. )/.test(s.trimStart());
        for (const block of blocks) {
            if (!block) {
                if (out.length && out[out.length - 1] !== '') out.push('');
                continue;
            }
            const prev = out.length ? out[out.length - 1] : '';
            const bothList = isItem(prev) && isItem(block);
            if (out.length && out[out.length - 1] !== '' && !bothList) out.push('');
            out.push(block);
        }
        return { markdown: out.join('\n').trim() + '\n', images };
    }

    extractMedia(names: string[], dest: string): string[] {
        const written: string[] = [];
        if (!names.length) return written;
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of this.zip.names()) {
            const base = path.posix.basename(entry);
            if (entry.startsWith('word/media/') && names.includes(base)) {
                const b = this.zip.read(entry);
                if (b) {
                    fs.writeFileSync(path.join(dest, base), b);
                    written.push(base);
                }
            }
        }
        return written;
    }
}

export interface ConvertResult {
    markdown: string;
    bytes: number;
    images: string[];
    mediaDir: string | null;
}

/** Convert `src` (.docx) to `dest` (.md); embedded images go to `<dest stem>.media/`. */
export function convertDocx(src: string, dest: string, mediaDir?: string, mediaPrefix?: string): ConvertResult {
    const doc = Docx.fromFile(src);
    const { markdown, images } = doc.toMarkdown();
    const stem = path.basename(dest, path.extname(dest));
    const md = mediaDir ?? path.join(path.dirname(dest), `${stem}.media`);
    const prefix = mediaPrefix ?? path.basename(md);
    const written = images.length ? doc.extractMedia(images, md) : [];
    const text = markdown.split('@@MEDIA@@').join(prefix);
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
    return { markdown: dest, bytes: Buffer.byteLength(text, 'utf8'), images: written, mediaDir: written.length ? md : null };
}

/** Markdown from .docx bytes, no files written (the runner's brief conversion). */
export function docxBytesToMarkdown(bytes: Uint8Array): string {
    return new Docx(new ZipReader(Buffer.from(bytes))).toMarkdown().markdown.split('@@MEDIA@@/').join('');
}
