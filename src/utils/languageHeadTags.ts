/**
 * Head tags a page writes itself that EF also writes for a page with a language
 * (multilingual sites). The runtime lets an author's own tag win, so a page that
 * keeps a hand-written hreflang / canonical / og:locale silently opts out of EF's.
 */
const RULES: Array<{ tag: string; re: RegExp }> = [
    { tag: 'hreflang', re: /<link\b[^>]*\bhreflang\s*=/i },
    { tag: 'canonical', re: /<link\b[^>]*\brel\s*=\s*["']?canonical\b/i },
    { tag: 'og:locale', re: /<meta\b[^>]*\bproperty\s*=\s*["']og:locale(?::alternate)?["']/i },
];

/** Names of the EF-managed language head tags the body declares itself, in a fixed order. */
export function ownLanguageHeadTags(body: string): string[] {
    if (!body) return [];
    // Backend comments and backend scripts are not page markup.
    const markup = body
        .replace(/\{\{--[\s\S]*?--\}\}/g, '')
        .replace(/<script\b[^>]*\bscope\s*=\s*["']?backend["']?[^>]*>[\s\S]*?<\/script>/gi, '');
    return RULES.filter((r) => r.re.test(markup)).map((r) => r.tag);
}

/** One-line warning for a page with a language that declares its own tags, or null. */
export function languageHeadTagsWarning(language: string | null | undefined, body: string): string | null {
    if (!language) return null;
    const tags = ownLanguageHeadTags(body);
    if (!tags.length) return null;
    return `has its own ${tags.join(', ')} tag${tags.length === 1 ? '' : 's'}: EF writes ${tags.length === 1 ? 'this' : 'these'} for pages with a language and steps back when the page declares ${tags.length === 1 ? 'it' : 'them'}. Remove ${tags.length === 1 ? 'it' : 'them'} unless you mean to override.`;
}
