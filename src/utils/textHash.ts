import { createHash } from 'crypto';
import { HTML5_ENTITIES } from './htmlEntities';

/**
 * Translation source hash: the fingerprint of a page's translatable text.
 *
 * A translation stores the hash of its source page at the time it was created
 * or last marked up to date (`translation_source_hash`). When the source's
 * current hash differs, the translation is stale. The app computes the same
 * hash in PHP, so both sides must produce identical bytes; shared test vectors
 * live in `test/fixtures/i18n-text-hash-vectors.json` here and in
 * `tests/fixtures/i18n-text-hash-vectors.json` in the app.
 *
 *   hash = sha256_hex(utf8(seo_title + "\n" + seo_description + "\n" + visibleText(html)))
 *
 * null / undefined fields count as "".
 *
 * visibleText(html), in this order:
 *   1. remove  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi   (replace with " ")
 *   2. remove  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi     (replace with " ")
 *   3. remove  /<!--[\s\S]*?-->/g                          (replace with " ")
 *   4. remove  /<\/?[A-Za-z!?](?:[^>"']|"[^"]*"|'[^']*')*>/g   (replace with " ")
 *      Tags and the doctype; a quoted attribute may contain ">". A "<" not
 *      followed by a letter, "/", "!" or "?" is text ("a < b" stays).
 *   5. decode entities like PHP html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8'):
 *      single pass; named references need the ";" and are case-sensitive
 *      (the 2125 names in htmlEntities.ts); numeric &#N; / &#xH; decode unless
 *      the code point is 0-8, 0x0B, 0x0D-0x1F, 0x7F-0x9F, a surrogate,
 *      0xFDD0-0xFDEF, any U+xFFFE / U+xFFFF, or above 0x10FFFF (then left as is).
 *   6. collapse every run of whitespace to one " ". Whitespace is exactly what
 *      PHP's /\s/u matches: \t \n \v \f \r, space, U+0085, U+00A0, U+1680,
 *      U+180E, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000
 *      (not U+FEFF, which JS's \s would include).
 *   7. trim " " from both ends.
 */

const WS_RUN = /[\t\n\v\f\r \u0085\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

function numericAllowed(cp: number): boolean {
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return false;
    if (cp <= 0x08 || cp === 0x0B || (cp >= 0x0D && cp <= 0x1F)) return false;
    if (cp >= 0x7F && cp <= 0x9F) return false;
    if (cp >= 0xD800 && cp <= 0xDFFF) return false;
    if (cp >= 0xFDD0 && cp <= 0xFDEF) return false;
    if ((cp & 0xFFFE) === 0xFFFE) return false;
    return true;
}

/** Decode HTML character references the way PHP's html_entity_decode(ENT_QUOTES | ENT_HTML5, UTF-8) does. */
export function decodeEntities(s: string): string {
    return s.replace(/&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*));/g, (whole, dec?: string, hex?: string, name?: string) => {
        if (name !== undefined) {
            return Object.prototype.hasOwnProperty.call(HTML5_ENTITIES, name) ? HTML5_ENTITIES[name] : whole;
        }
        const digits = dec ?? hex ?? '';
        // Long digit strings overflow; anything past 0x10FFFF is refused anyway.
        const trimmed = digits.replace(/^0+(?=.)/, '');
        if (trimmed.length > 8) return whole;
        const cp = parseInt(trimmed, dec !== undefined ? 10 : 16);
        return numericAllowed(cp) ? String.fromCodePoint(cp) : whole;
    });
}

/** The page's visible text: markup, scripts, styles and comments removed, entities decoded, whitespace collapsed. */
export function visibleText(html: string | null | undefined): string {
    let s = html ?? '';
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<\/?[A-Za-z!?](?:[^>"']|"[^"]*"|'[^']*')*>/g, ' ');
    s = decodeEntities(s);
    s = s.replace(WS_RUN, ' ');
    return s.replace(/^ +| +$/g, '');
}

/** sha256 hex of seo_title + "\n" + seo_description + "\n" + visibleText(html). */
export function translationSourceHash(input: { seo_title?: string | null; seo_description?: string | null; html?: string | null }): string {
    const text = `${input.seo_title ?? ''}\n${input.seo_description ?? ''}\n${visibleText(input.html)}`;
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
