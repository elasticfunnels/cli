// Static .ef linter — checks a file WITHOUT executing it. Covers ALL THREE layers
// of a .ef file:
//   1. Backend template logic  ({{ }} engine + @directives + filters)
//   2. Frontend template logic ([[ ]] engine + <template-*> + bindings)
//   3. Backend script logic     (<script scope="backend"> + scripts/*.js — pure JS)
//   4. Cross-cutting            (efmeta guardrail, engine bleed between layers)
//
// Side-effect-free core (unit-testable on a string); `lintEfFile` adds filesystem
// resolution of @extends / @component / import targets. Ported from the
// elasticfunnels-cc-runner `lint_ef` module. Never executes anything.
import * as path from 'path';
import * as fs from 'fs';
import { Parser } from 'acorn';

export type Severity = 'error' | 'warning';
export interface LintIssue {
    line?: number;
    message: string;
    severity: Severity;
}
export interface LintResult {
    ok: boolean; // true = no errors (warnings allowed)
    issues: LintIssue[];
}

export type EfKind = 'page' | 'component' | 'script';

export interface LintOptions {
    /** Entity kind. Inferred from filePath when omitted. */
    kind?: EfKind;
    /** Brand-root-relative file path (for messages + kind inference). */
    filePath?: string;
    /** Resolve whether a component `code` exists (components/<code>.ef). */
    componentExists?: (code: string) => boolean;
    /** Resolve whether an @extends base slug exists (pages/<slug>.ef). */
    pageExists?: (slug: string) => boolean;
    /** Resolve whether an imported backend-script code exists (scripts/<code>.js). */
    scriptExists?: (code: string) => boolean;
}

// ── Grammar tables ────────────────────────────────────────────────────

/** Valid backend `@`-directives in paren form: `@name(`. */
const KNOWN_PAREN_DIRECTIVES = new Set([
    'if',
    'elseif',
    'foreach',
    'set',
    'component',
    'extends',
    'block',
    'yield',
    'setSessionItem',
    'clearSessionItem',
]);

/** Valid backend `@end*` closers. */
const KNOWN_END_DIRECTIVES = new Set(['endif', 'endforeach', 'endblock']);

/** CSS at-rules — NOT template directives. `@media (…)` / `@supports (…)` /
 *  `@container (…)` are followed by `(` and must never be flagged as unknown
 *  `@name(` directives (they're valid CSS inside <style>). */
const CSS_AT_RULES = new Set([
    'media',
    'supports',
    'container',
    'layer',
    'keyframes',
    'font-face',
    'import',
    'charset',
    'page',
    'namespace',
    'property',
    'counter-style',
    'font-feature-values',
    'document',
    'viewport',
    'scope',
    'starting-style',
]);

/** Backend `{{ … | filter }}` filters. */
const KNOWN_BACKEND_FILTERS = new Set([
    'default',
    'default_if_none',
    'upper',
    'lower',
    'capitalize',
    'title',
    'trim',
    'first',
    'last',
    'slice',
    'replace',
    'truncate',
    'truncatewords',
    'nl2br',
    'strip_tags',
    'url_encode',
    'length',
    'size',
    'round',
    'floor',
    'ceil',
    'abs',
    'number_format',
    'currency',
    'yesno',
    'join',
    'sort',
    'reverse',
    'unique',
    'date',
    'date_add',
    'timeago',
    'raw',
    'json',
    't',
    'upsell_upgrade',
    'upsell_cancel',
]);

/** Frontend `[[ … ]]` built-in functions. */
const KNOWN_FRONTEND_FUNCS = new Set([
    'formatPrice',
    'money',
    'formatCurrency',
    'lineTotal',
    'cartCount',
    'cart_count',
    'cartSubtotal',
    'cart_subtotal',
    'upper',
    'uppercase',
    'lower',
    'lowercase',
    'capitalize',
    'titleCase',
    'title',
    'camelCase',
    'camel',
    'snakeCase',
    'snake',
    'kebabCase',
    'kebab',
]);

/** Custom frontend elements that must be tag-balanced. */
const FRONTEND_TEMPLATE_TAGS = ['template-if', 'template-else-if', 'template-else', 'template-foreach', 'template-vars', 'template-set', 'template-component'];

/** Wrong-framework binding attributes that don't exist in the EF engines. */
const ALIEN_BINDINGS = ['v-if', 'v-for', 'v-show', 'x-if', 'x-for', 'x-show', 'ng-if', 'ng-for', ':v-if'];

// ── Small utilities ───────────────────────────────────────────────────

function lineAt(text: string, pos: number): number {
    let line = 1;
    for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
}

/** Replace every match with same-length whitespace (newlines preserved) so line
 *  numbers stay stable when we blank out one layer before scanning another. */
function blankOut(text: string, re: RegExp): string {
    return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

const BACKEND_SCRIPT_RE = /<script\b[^>]*\bscope\s*=\s*["']backend["'][^>]*>([\s\S]*?)<\/script>/gi;
const BACKEND_COMMENT_RE = /\{\{--[\s\S]*?--\}\}/g;

// ── Cross-cutting: efmeta ─────────────────────────────────────────────

function checkEfmeta(content: string, kind: EfKind, issues: LintIssue[]): void {
    const lines = content.split('\n');
    // A missing line-1 efmeta is NOT flagged: new pages are stamped by the system on
    // save, and the agent shouldn't write identity lines itself. We ONLY flag a
    // DUPLICATED efmeta past line 1 (a copied identity that would wrongly bind this
    // file to another entity).
    const dupRe = kind === 'script' ? /^\s*\/\/\s*efmeta:/ : /\{\{--\s*efmeta:/;
    for (let i = 1; i < lines.length; i++) {
        if (dupRe.test(lines[i])) {
            issues.push({
                line: i + 1,
                severity: 'error',
                message:
                    'Duplicated efmeta line — this binds the file to another entity\'s identity. Strip the efmeta line when duplicating content (copy the BODY only).',
            });
        }
    }
}

// ── Layer 1: backend {{ }} + @directives ──────────────────────────────

/** Find `{{` tags never closed by `}}` (parser treats these as literal text). */
function findUnclosedInterp(html: string, issues: LintIssue[]): void {
    let i = 0;
    while (i < html.length) {
        const open = html.indexOf('{{', i);
        if (open === -1) break;
        const triple = html[open + 2] === '{';
        const closer = triple ? '}}}' : '}}';
        const close = html.indexOf(closer, open + (triple ? 3 : 2));
        if (close === -1) {
            issues.push({ line: lineAt(html, open), message: 'Unclosed {{ … }} tag.', severity: 'error' });
            break;
        }
        i = close + closer.length;
    }
}

/** Balance + ordering of @if/@elseif/@else/@endif, @foreach/@endforeach, @block/@endblock. */
function checkDirectiveBalance(html: string, issues: LintIssue[]): void {
    const re = /@(endforeach|endblock|endif|elseif|foreach|block|else|if)\b/g;
    const stack: { kind: 'if' | 'foreach' | 'block'; line: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const tok = m[1];
        const line = lineAt(html, m.index);
        switch (tok) {
            case 'if':
                stack.push({ kind: 'if', line });
                break;
            case 'foreach':
                stack.push({ kind: 'foreach', line });
                break;
            case 'block':
                stack.push({ kind: 'block', line });
                break;
            case 'elseif':
            case 'else':
                if (stack.length === 0 || stack[stack.length - 1].kind !== 'if') {
                    issues.push({ line, severity: 'error', message: `@${tok} outside an open @if block.` });
                }
                break;
            case 'endif':
                if (stack.length === 0 || stack[stack.length - 1].kind !== 'if') {
                    issues.push({ line, severity: 'error', message: '@endif without a matching @if.' });
                } else stack.pop();
                break;
            case 'endforeach':
                if (stack.length === 0 || stack[stack.length - 1].kind !== 'foreach') {
                    issues.push({ line, severity: 'error', message: '@endforeach without a matching @foreach.' });
                } else stack.pop();
                break;
            case 'endblock':
                if (stack.length === 0 || stack[stack.length - 1].kind !== 'block') {
                    issues.push({ line, severity: 'error', message: '@endblock without a matching @block.' });
                } else stack.pop();
                break;
        }
    }
    for (const open of stack) {
        issues.push({ line: open.line, severity: 'error', message: `Unclosed @${open.kind} — add the matching @end${open.kind}.` });
    }
}

/** Unknown @-directives that render as LITERAL TEXT (the @for vs @foreach trap). */
function checkUnknownDirectives(html: string, issues: LintIssue[]): void {
    const dirRe = /(?:^|[^\w@.])@(end[a-zA-Z]+|[a-zA-Z]+\s*\()/g;
    let m: RegExpExecArray | null;
    while ((m = dirRe.exec(html)) !== null) {
        const raw = m[1];
        if (raw.endsWith('(')) {
            const name = raw.slice(0, -1).trim();
            // CSS at-rules (@media/@supports/@container/…) are valid CSS, not directives.
            if (CSS_AT_RULES.has(name.toLowerCase())) continue;
            if (!KNOWN_PAREN_DIRECTIVES.has(name)) {
                issues.push({
                    line: lineAt(html, m.index),
                    severity: 'error',
                    message: `Unknown directive @${name}(…) — the engine has no @${name}. Use @foreach/@if/@elseif/@set/@component/@extends/@block/@yield. (It would render as literal text.)`,
                });
            }
        } else if (!KNOWN_END_DIRECTIVES.has(raw)) {
            issues.push({
                line: lineAt(html, m.index),
                severity: 'error',
                message: `Unknown closing directive @${raw} — valid closers are @endif / @endforeach / @endblock.`,
            });
        }
    }
}

/** Validate filters in {{ … | filter[:arg] }} and flag raw < / > inside @if(). */
function checkExpressionsAndFilters(html: string, issues: LintIssue[]): void {
    // Interpolations: {{ … }} (and {{{ … }}}).
    const interpRe = /\{\{\{?([\s\S]*?)\}?\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = interpRe.exec(html)) !== null) {
        const inner = m[1];
        const line = lineAt(html, m.index);
        if (inner.trim() === '') {
            issues.push({ line, severity: 'warning', message: 'Empty {{ }} interpolation.' });
            continue;
        }
        // Engine bleed: [[ ]] inside a {{ }}.
        if (/\[\[/.test(inner)) {
            issues.push({ line, severity: 'error', message: 'Frontend [[ ]] found inside a backend {{ }} — do not nest the two engines.' });
        }
        // Filters: split on top-level "|" (ignore || logical-or and |'s inside quotes).
        for (const f of parseFilterNames(inner)) {
            if (!KNOWN_BACKEND_FILTERS.has(f.name)) {
                issues.push({
                    line,
                    severity: 'warning',
                    message: `Unknown backend filter "${f.name}". Known filters include default, upper, lower, date, currency, truncate, raw, json, t …`,
                });
            }
        }
    }

    // Raw < / > inside @if(…) / @elseif(…) conditions → prefer word operators.
    const condRe = /@(?:else)?if\s*\(([\s\S]*?)\)/g;
    while ((m = condRe.exec(html)) !== null) {
        const cond = m[1];
        // Ignore <=, >=, =>, ->, <>, and arrow/spread forms; flag a bare < or >.
        const bare = /(^|[^<>=!-])[<>](?![=>])/;
        if (bare.test(cond)) {
            issues.push({
                line: lineAt(html, m.index),
                severity: 'warning',
                message: 'Raw < or > in an @if condition can break HTML parsing — prefer the word operators lt / lte / gt / gte.',
            });
        }
    }
}

interface FilterRef {
    name: string;
}
/** Extract filter names from an interpolation body: split on top-level `|`. */
function parseFilterNames(inner: string): FilterRef[] {
    const out: FilterRef[] = [];
    let depth = 0;
    let quote: string | null = null;
    let seg = '';
    const segs: string[] = [];
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote) {
            if (ch === quote && inner[i - 1] !== '\\') quote = null;
            seg += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            seg += ch;
            continue;
        }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === '|' && depth === 0 && inner[i + 1] !== '|' && inner[i - 1] !== '|') {
            segs.push(seg);
            seg = '';
            continue;
        }
        seg += ch;
    }
    segs.push(seg);
    // First segment is the value; the rest are filters.
    for (let i = 1; i < segs.length; i++) {
        const s = segs[i].trim();
        if (!s) continue;
        const name = s.split(/[:(\s]/)[0];
        if (name) out.push({ name });
    }
    return out;
}

/** @extends("slug") / @component("code", …) target existence (when resolvers given). */
function checkStructuralTargets(html: string, opts: LintOptions, issues: LintIssue[]): void {
    if (opts.pageExists) {
        const re = /@extends\s*\(\s*["']([^"']+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
            const slug = m[1].replace(/\.ef$/, '');
            if (!opts.pageExists(slug)) {
                issues.push({ line: lineAt(html, m.index), severity: 'error', message: `@extends base page "${slug}" not found (pages/${slug}.ef).` });
            }
        }
    }
    if (opts.componentExists) {
        const re = /@component\s*\(\s*["']([^"']+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
            const code = m[1].replace(/\.ef$/, '');
            if (!opts.componentExists(code)) {
                issues.push({ line: lineAt(html, m.index), severity: 'error', message: `Unknown component "${code}" (no components/${code}.ef).` });
            }
        }
    }
}

// ── Layer 2: frontend [[ ]] + <template-*> ────────────────────────────

function findUnclosedFrontend(html: string, issues: LintIssue[]): void {
    let i = 0;
    while (i < html.length) {
        const open = html.indexOf('[[', i);
        if (open === -1) break;
        const close = html.indexOf(']]', open + 2);
        if (close === -1) {
            issues.push({ line: lineAt(html, open), message: 'Unclosed [[ … ]] tag.', severity: 'error' });
            break;
        }
        const inner = html.slice(open + 2, close);
        if (inner.trim() === '') issues.push({ line: lineAt(html, open), severity: 'warning', message: 'Empty [[ ]] expression.' });
        if (/\{\{/.test(inner)) issues.push({ line: lineAt(html, open), severity: 'error', message: 'Backend {{ }} found inside a frontend [[ ]] — do not nest the two engines.' });
        // Unknown frontend function calls (warning; custom functions may be registered).
        for (const call of inner.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
            const name = call[1];
            if (!KNOWN_FRONTEND_FUNCS.has(name)) {
                issues.push({
                    line: lineAt(html, open),
                    severity: 'warning',
                    message: `Unknown frontend function "${name}()" in [[ ]] — if it isn't registered via registerTemplateFunction it will fail. Known helpers: formatPrice, cartCount, cartSubtotal, lineTotal, upper/lower/capitalize/titleCase…`,
                });
            }
        }
        i = close + 2;
    }
}

function checkFrontendDirectives(html: string, issues: LintIssue[]): void {
    // Alien framework bindings anywhere → wrong engine.
    for (const attr of ALIEN_BINDINGS) {
        const re = new RegExp(`\\b${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
            issues.push({
                line: lineAt(html, m.index),
                severity: 'error',
                message: `"${attr}" is not an ElasticFunnels binding. Use <template-if data-condition> / <template-foreach data-each> and [[ ]] expressions.`,
            });
        }
    }

    // <template-if> must carry data-condition.
    let m: RegExpExecArray | null;
    const ifRe = /<template-if\b([^>]*)>/gi;
    while ((m = ifRe.exec(html)) !== null) {
        if (!/\bdata-condition\s*=/.test(m[1])) {
            issues.push({ line: lineAt(html, m.index), severity: 'error', message: '<template-if> requires a data-condition attribute.' });
        }
    }
    // <template-else-if> must carry data-condition.
    const elifRe = /<template-else-if\b([^>]*)>/gi;
    while ((m = elifRe.exec(html)) !== null) {
        if (!/\bdata-condition\s*=/.test(m[1])) {
            issues.push({ line: lineAt(html, m.index), severity: 'error', message: '<template-else-if> requires a data-condition attribute.' });
        }
    }
    // <template-foreach> must carry data-each / data-for (or legacy data-item/data-array).
    const feRe = /<template-foreach\b([^>]*)>/gi;
    while ((m = feRe.exec(html)) !== null) {
        if (!/\bdata-(each|for|item|array)\s*=/.test(m[1])) {
            issues.push({ line: lineAt(html, m.index), severity: 'error', message: '<template-foreach> requires a data-each (or data-for) attribute, e.g. data-each="item in items".' });
        }
    }
}

/** Balance of the custom <template-*> elements. */
function checkFrontendTagBalance(html: string, issues: LintIssue[]): void {
    const tagsAlt = FRONTEND_TEMPLATE_TAGS.join('|');
    const re = new RegExp(`<(/?)(${tagsAlt})\\b([^>]*)>`, 'gi');
    const stack: { tag: string; line: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        const attrs = m[3] || '';
        const selfClosed = /\/\s*$/.test(attrs);
        const line = lineAt(html, m.index);
        if (closing) {
            // pop the nearest matching open tag
            let idx = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === tag) {
                    idx = i;
                    break;
                }
            }
            if (idx === -1) {
                issues.push({ line, severity: 'error', message: `Stray </${tag}> with no matching open tag.` });
            } else {
                stack.splice(idx, 1);
            }
        } else if (!selfClosed) {
            stack.push({ tag, line });
        }
    }
    for (const open of stack) {
        issues.push({ line: open.line, severity: 'error', message: `Unclosed <${open.tag}> — add the matching </${open.tag}>.` });
    }
}

// ── Layer 3: backend scripts (pure JS) ────────────────────────────────

const TEMPLATE_IN_JS_RE = /\{\{|@(?:if|elseif|else|endif|foreach|endforeach|set|component|extends|block|endblock|yield)\b/;
const NODE_API_RE = /\brequire\s*\(|__dirname|__filename|\bprocess\.(?:env|argv|cwd|exit)|\bfrom\s+["'](?:node:)?(?:fs|path|http|https|os|child_process|crypto|stream|net|fs\/promises)["']|import\s+["'](?:node:)?(?:fs|path|http|https|os|child_process)["']/;

/** Lint a chunk of backend JS. `baseLine` offsets reported lines into the file. */
function lintBackendScript(code: string, baseLine: number, issues: LintIssue[]): void {
    const rel = (offset: number) => baseLine + offset - 1;

    // Template directives don't belong in JS.
    const tmpl = TEMPLATE_IN_JS_RE.exec(code);
    if (tmpl) {
        issues.push({
            line: rel(lineAt(code, tmpl.index)),
            severity: 'error',
            message: 'Template syntax ({{ }} / @directive) inside a backend script — backend scripts are pure JavaScript. Pass data to the template with setVariable(key, value).',
        });
    }

    // Node/fs APIs are unavailable in the QuickJS sandbox.
    const node = NODE_API_RE.exec(code);
    if (node) {
        issues.push({
            line: rel(lineAt(code, node.index)),
            severity: 'warning',
            message: 'Node/filesystem API used in a backend script — the sandbox has no Node, fs, path, http, process, require or __dirname. Use the provided data functions instead.',
        });
    }

    // Import rules: bare code specifiers, ≤10 imports, 1 level deep, not named+default together.
    checkScriptImports(code, baseLine, issues);

    // Must parse as JS (module).
    try {
        Parser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
    } catch (err) {
        const e = err as { message?: string; loc?: { line?: number } };
        const at = (e.loc && e.loc.line != null) ? rel(e.loc.line) : baseLine;
        issues.push({ line: at, severity: 'error', message: `Backend script does not parse: ${(e.message || 'syntax error').split('\n')[0]}` });
    }
}

function checkScriptImports(code: string, baseLine: number, issues: LintIssue[]): void {
    const importRe = /^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = importRe.exec(code)) !== null) {
        count++;
        const clause = m[1].trim();
        const spec = m[2].trim();
        const line = baseLine + lineAt(code, m.index) - 1;

        // Not both a default and a named binding on one line.
        if (/^\w[\w$]*\s*,\s*\{/.test(clause)) {
            issues.push({ line, severity: 'error', message: `Import "${spec}" mixes a default and named bindings on one line — split them into two imports.` });
        }
        // Bare code, one level deep — a specifier resolving to scripts/<code>.js.
        const bare = spec.replace(/^\.?\//, '');
        if (spec.includes('..') || bare.includes('/')) {
            issues.push({ line, severity: 'error', message: `Import "${spec}" must reference a backend-script code (1 level deep), e.g. import { fn } from "auth" → scripts/auth.js. No subpaths or ../.` });
        }
    }
    if (count > 10) {
        issues.push({ line: baseLine, severity: 'error', message: `Too many imports (${count}) — a backend script may import at most 10 modules.` });
    }
}

// ── Public API ────────────────────────────────────────────────────────

function inferKind(filePath?: string): EfKind {
    if (!filePath) return 'page';
    const p = filePath.replace(/\\/g, '/');
    if (p.startsWith('scripts/') || p.endsWith('.js')) return 'script';
    if (p.startsWith('components/')) return 'component';
    return 'page';
}

/** Lint a .ef page/component body or a scripts/*.js body from a string. */
export function lintEfContent(content: string, opts: LintOptions = {}): LintResult {
    const issues: LintIssue[] = [];
    const kind = opts.kind ?? inferKind(opts.filePath);

    checkEfmeta(content, kind, issues);

    if (kind === 'script') {
        // The whole file is JS. Strip the `// efmeta:` first line for accurate lines.
        const lines = content.split('\n');
        const hasMeta = /^\s*\/\/\s*efmeta:/.test(lines[0] ?? '');
        const body = hasMeta ? lines.slice(1).join('\n') : content;
        const baseLine = hasMeta ? 2 : 1;
        lintBackendScript(body, baseLine, issues);
        return finalize(issues);
    }

    // page / component: strip backend comments; extract + lint each backend script
    // block; blank the script blocks out so the template scans don't see their JS.
    const noComments = blankOut(content, BACKEND_COMMENT_RE);

    let sm: RegExpExecArray | null;
    BACKEND_SCRIPT_RE.lastIndex = 0;
    while ((sm = BACKEND_SCRIPT_RE.exec(content)) !== null) {
        const inner = sm[1];
        const innerStart = sm.index + sm[0].indexOf(inner);
        lintBackendScript(inner, lineAt(content, innerStart), issues);
    }
    const cleaned = blankOut(noComments, BACKEND_SCRIPT_RE);

    // Layer 1: backend {{ }} + directives
    findUnclosedInterp(cleaned, issues);
    checkDirectiveBalance(cleaned, issues);
    checkUnknownDirectives(cleaned, issues);
    checkExpressionsAndFilters(cleaned, issues);
    checkStructuralTargets(cleaned, opts, issues);

    // Layer 2: frontend [[ ]] + <template-*>
    findUnclosedFrontend(cleaned, issues);
    checkFrontendDirectives(cleaned, issues);
    checkFrontendTagBalance(cleaned, issues);

    return finalize(issues);
}

function finalize(issues: LintIssue[]): LintResult {
    // Stable order by line, errors before warnings on the same line.
    issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/**
 * Lint a file on disk within the brand root, resolving @extends / @component /
 * import targets against sibling files. `dir` is the brand root (contains
 * pages/ components/ scripts/); `relFile` is brand-root-relative (e.g.
 * "pages/home.ef" or "home.ef", or "scripts/auth.js").
 */
export function lintEfFile(dir: string, relFile: string): LintResult {
    // Accept "home.ef" (implicitly under pages/) or a full rel path.
    let rel = relFile.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!/^(pages|components|scripts)\//.test(rel)) rel = `pages/${rel}`;
    const abs = path.join(dir, rel);
    let content: string;
    try {
        content = fs.readFileSync(abs, 'utf8');
    } catch {
        return { ok: false, issues: [{ severity: 'error', message: `File not found: ${rel}` }] };
    }
    const exists = (sub: string) => {
        try {
            return fs.existsSync(path.join(dir, sub));
        } catch {
            return false;
        }
    };
    return lintEfContent(content, {
        filePath: rel,
        componentExists: (code) => exists(`components/${code}.ef`),
        pageExists: (slug) => exists(`pages/${slug}.ef`),
        scriptExists: (code) => exists(`scripts/${code}.js`),
    });
}
