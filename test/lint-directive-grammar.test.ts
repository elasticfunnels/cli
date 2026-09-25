import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { lintEfContent } from '../src/lint/lintEf';

/**
 * The linter must agree with the runtime tokenizer (website
 * src/services/TemplateEngine/Tokenizer.js) about which `@` starts a directive.
 *
 * The runtime runs a directive when the `@` is at line start, or mid-line when it
 * is one of the inline directives: @if( @elseif( @else @endif @foreach(
 * @endforeach @each( @endeach @component( @endcomponent @yield( @set(
 * @setSessionItem( @clearSessionItem(. @block( runs mid-line only right after a
 * tag (`>`) or with its @endblock on the same line; @extends( only at line start.
 * Anything else mid-line is printed as text.
 */

function issuesFor(html: string): string[] {
    return lintEfContent(html, { kind: 'page' }).issues.map((i) => `${i.severity} L${i.line} ${i.message}`);
}

function assertClean(html: string, why: string): void {
    const found = issuesFor(html);
    assert.deepEqual(found, [], `${why}\n  got: ${found.join('\n       ')}`);
}

function assertReports(html: string, needle: RegExp, why: string): void {
    const found = issuesFor(html);
    assert.ok(found.some((i) => needle.test(i)), `${why}\n  got: ${found.join('\n       ') || '(nothing)'}`);
}

test('inline @if…@set…@endif on one line is accepted', () => {
    assertClean("@if(_ab_loc eq 'en')@set(_ab_show = 'yes')@endif\n<nav>{{ _ab_show }}</nav>\n", 'runtime executes this');
    assertClean("<p>Hi @set(name = 'Ann'){{ name }}</p>\n", '@set after text runs');
    assertClean('@set(a = 1)@set(b = 2)\n', 'two @set on one line');
    assertClean("@if(x eq 1)@if(y)@set(r = 'a')@else@set(r = 'b')@endif@else@set(r = 'c')@endif\n", 'nested inline if/else');
    assertClean("<p>@setSessionItem('k', 'v') @clearSessionItem('k')</p>\n", 'session directives run inline');
});

test('@each / @endeach and @endcomponent are known directives', () => {
    assertClean('<ul>@each(p in ps)<li>{{ p.name }}</li>@endeach</ul>\n', '@each is an alias of @foreach');
    assertClean('@each(p in ps)\n{{ p }}\n@endforeach\n', 'closers are interchangeable');
    assertReports('@each(p in ps)\n{{ p }}\n', /Unclosed @foreach/, 'an unclosed @each is still caught');
});

test('mid-line @extends / @block that the runtime prints as text are reported', () => {
    assertReports('<p>see @extends("layout")</p>\n', /@extends.*own line/, 'mid-line @extends is text');
    assertReports('<p>Add a @block("content") here</p>\n@endblock\n', /@block.*printed as text/, 'mid-line @block in prose is text');
    assertClean('@extends("layout")\n@block("content")\n<p>x</p>\n@endblock\n', 'line-start forms');
    assertClean('<title>@block("title")About@endblock</title>\n', 'one-line @block…@endblock runs');
    assertClean('</style> @block("head")\n@endblock\n', '@block right after a tag runs');
});

test('function directives other than the session ones are line-start only', () => {
    assertReports('<p>see @dump(x)</p>\n', /Unknown directive @dump/, 'still unknown to the linter');
});

test('literal @ in prose, CSS and JS is not flagged', () => {
    assertClean('<p>Mail support@example.com or follow @elasticfunnels, use @set to assign.</p>\n', 'prose');
    assertClean('<style>@media (max-width: 600px){a{b:c}}@supports (display:grid){a{b:c}}</style>\n', 'CSS at-rules');
});
