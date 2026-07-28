// Static .ef linter — checks a file WITHOUT executing it. Covers ALL THREE layers
// of a .ef file (phase-4 §B.4):
//   1. Backend template logic  ({{ }} engine + @directives + filters)
//   2. Frontend template logic ([[ ]] engine + <template-*> + bindings)
//   3. Backend script logic     (<script scope="backend"> + scripts/*.js — pure JS)
//   4. Cross-cutting            (efmeta guardrail, engine bleed between layers)
//
// Built as a SHARED, side-effect-free module so the same linter backs the runner's
// `lint_ef` MCP tool AND (optionally) an `ef lint` CLI. The core operates on a
// string (unit-testable); `lintEfFile` adds filesystem resolution of @extends /
// @component targets.
//
// Grammar sources of truth: elasticfunnels-docs backend/frontend template-engine
// pages; Modules/TemplateEngine BackendTemplateSyntaxConverter + the frontend
// engine JS. Never executes anything.
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

/** Backend `{{ … | filter }}` filters (elasticfunnels-docs variables-and-filters). */
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

/** Frontend `[[ … ]]` built-in functions (frontend-template-engine built-in-functions). */
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

/** Page-events container tags. Their CONTENT is the default shown when no test
 *  is running; the variants live in the page-events graph, not in the markup. */
const CONTAINER_TAGS = ['split-test', 'dynamic-container'];

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
          message: `Unknown backend filter "${f.name}". Known filters include default, upper, lower, date, currency, truncate, raw, json, t … (check the ef-template-directives skill).`,
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
  // <template-else-if> must carry data-condition; <template-else> must NOT.
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

/**
 * `<template-component>` and page-events containers.
 *
 * VERIFIED AGAINST THE RUNTIME (2026-07): NOTHING resolves `<template-component>`.
 *   - browser engine (offer repo resources/js/utils/templateProcessor.js) registers
 *     only template-if / else-if / else / foreach / vars / set / partial;
 *   - ComponentToken.js matches the literal `@component`;
 *   - ComponentProcessor.js matches `<component type>` / data-component-type;
 *   - the app's BackendTemplateSyntaxConverter rewrites <backend-component>, not this.
 * It ships to the browser as an inert unknown element and, being normally empty,
 * renders NOTHING — silently, with no error anywhere. Several docs pages describe
 * it as working, which is why it keeps getting written; the linter is where that
 * gets caught. There is no component namespace to resolve `data-component-name`
 * against, so the tag is rejected outright rather than target-checked.
 *
 * CONTAINERS RESOLVE FIRST. backendfunnel runs the page-events graph
 * (pages/page.js processBackendEvents) BEFORE the page pipeline and long before
 * RawPageProcessor.render() evaluates `{{ }}`/@if — and the browser's
 * <template-if> is later still. ComponentSplitTestService.predict_component has
 * already picked the variant, written the st_res_<id> cookie and pushed the id
 * into session.sids by then. So a container wrapped in a condition still ENROLLS
 * the visitor in the test; the condition only discards the output afterwards,
 * skewing the split test and its attribution.
 */
function checkTemplateComponentAndContainers(html: string, issues: LintIssue[]): void {
  // Where the conditional regions are, so a container inside one can be spotted.
  // Two independent depths: the backend @if…@endif, and the frontend
  // <template-if>/<template-else-if>/<template-else> elements.
  const markerRe =
    /@(endif|elseif|else|if)\b|<(\/?)(template-if|template-else-if|template-else)\b(?:[^>"']|"[^"]*"|'[^']*')*>|<(split-test|dynamic-container)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

  let backendDepth = 0;
  let frontendDepth = 0;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(html)) !== null) {
    if (m[1]) {
      const tok = m[1].toLowerCase();
      if (tok === 'if') backendDepth++;
      else if (tok === 'endif') backendDepth = Math.max(0, backendDepth - 1);
      continue;
    }
    if (m[3]) {
      if (m[2] === '/') frontendDepth = Math.max(0, frontendDepth - 1);
      else frontendDepth++;
      continue;
    }
    // A container open tag.
    const tag = m[4].toLowerCase();
    const attrs = m[5] || '';
    if (backendDepth === 0 && frontendDepth === 0) continue;
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']*)["']/i);
    const id = idMatch ? idMatch[1] : '';
    const wrapper = frontendDepth > 0 ? '<template-if>' : '@if';
    issues.push({
      line: lineAt(html, m.index),
      severity: 'warning',
      message:
        `<${tag}${id ? ` id="${id}"` : ''}> is nested inside ${wrapper}, which does NOT gate it. ` +
        'Containers are filled by the page-events graph BEFORE the backend engine renders and long before the browser runs <template-if>: the variant is already chosen, the assignment cookie written and the visitor counted in the test. ' +
        'The condition only hides the result, skewing the split test and its attribution. Keep the container unconditional and put the condition inside its default content or inside each variant component.',
    });
  }

  // <template-component> — unimplemented anywhere. One error per tag, with the
  // container mental-model correction folded in when it sits inside one (that is
  // the deeper mistake: thinking the variants live in the markup).
  const containerRegions: [number, number][] = [];
  const containerRe = new RegExp(`<(${CONTAINER_TAGS.join('|')})\\b[^>]*>([\\s\\S]*?)</\\1\\s*>`, 'gi');
  let c: RegExpExecArray | null;
  while ((c = containerRe.exec(html)) !== null) containerRegions.push([c.index, c.index + c[0].length]);

  const tcRe = /<template-component\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  while ((m = tcRe.exec(html)) !== null) {
    const inContainer = containerRegions.some(([a, b]) => m!.index > a && m!.index < b);
    issues.push({
      line: lineAt(html, m.index),
      severity: 'error',
      message:
        '<template-component> is not implemented by anything — not the frontend engine, not the backend engine, not the server pipeline. It reaches the browser as an inert unknown element and renders NOTHING, silently (some docs pages still describe it as working; they are wrong). ' +
        'For server-side composition use the backend directive @component("code", {}). For content that gets swapped or split-tested, use a <split-test>/<dynamic-container> plus a page-events node.' +
        (inContainer
          ? ' Inside a container it is doubly wrong: a container\'s contents are only the DEFAULT shown when no test is running, and a container renders exactly ONE thing. The VARIANTS live in the page-events graph — component_split_test → one split_test_weight per variant (totalling 100) → one component_split_test_component each — and replace that default at request time.'
          : ''),
    });
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

/**
 * Backend scripts run in a QuickJS sandbox — NOT Node and NOT a browser. It has the
 * ECMAScript builtins (JSON, Math, Date, String, Array, Object, Promise, RegExp,
 * Map, Set…) plus the EF host objects, and nothing else. Web/Node globals that
 * "obviously" exist elsewhere throw `X is not defined` at request time, which the
 * author only discovers on a live page — so flag them statically.
 *
 * Each entry carries the workaround, because "not defined" alone doesn't tell the
 * author what to do instead.
 */
const SANDBOX_MISSING_GLOBALS: Record<string, string> = {
  URLSearchParams: 'build the query string manually, e.g. Object.keys(request.query).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(request.query[k])).join("&")',
  URL: 'assemble/parse URLs with plain string operations',
  fetch: 'use the injected `http` object for outbound requests',
  XMLHttpRequest: 'use the injected `http` object',
  TextEncoder: 'not available — work with strings directly',
  TextDecoder: 'not available — work with strings directly',
  atob: 'not available — avoid base64 in backend scripts',
  btoa: 'not available — avoid base64 in backend scripts',
  Buffer: 'Node-only — not available',
  setTimeout: 'there is no event loop in a request-scoped script; do the work inline',
  setInterval: 'there is no event loop in a request-scoped script',
  localStorage: 'browser-only — use the injected `storage` or `cache` objects',
  sessionStorage: 'browser-only — use the injected `session` object',
  window: 'browser-only — backend scripts run on the server',
  document: 'browser-only — backend scripts run on the server',
  navigator: 'browser-only — use request.headers["user-agent"] / request.is_mobile',
  location: 'browser-only — use request.path / request.query',
  crypto: 'not available in the sandbox',
  alert: 'browser-only',
};

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

  // Globals the QuickJS sandbox does NOT have. These are hard runtime failures
  // ("URLSearchParams is not defined") that only show up on a live request, so an
  // ERROR here is the whole point of linting backend scripts.
  for (const [name, hint] of Object.entries(SANDBOX_MISSING_GLOBALS)) {
    // Bare identifier use only: skip property access (obj.fetch) and declarations
    // (const fetch = …), which are legitimate.
    const re = new RegExp(`(^|[^\\w.$])${name}\\b(?!\\s*[:=][^=])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      issues.push({
        line: rel(lineAt(code, m.index)),
        severity: 'error',
        message: `"${name}" does not exist in the backend-script sandbox (QuickJS — not Node, not a browser), so this throws "${name} is not defined" at request time. Instead: ${hint}.`,
      });
      break; // one report per global is enough
    }
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
  checkTemplateComponentAndContainers(cleaned, issues);
  checkFrontendTagBalance(cleaned, issues);

  return finalize(issues);
}

function finalize(issues: LintIssue[]): LintResult {
  // Stable order by line, errors before warnings on the same line.
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/**
 * Lint a file on disk within a materialized workspace, resolving @extends /
 * @component / import targets against sibling files. `dir` is the brand root
 * (contains pages/ components/ scripts/); `relFile` is brand-root-relative
 * (e.g. "pages/home.ef" or "home.ef", or "scripts/auth.js").
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
