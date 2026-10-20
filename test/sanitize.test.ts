import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { hasControlChars, safeCell, safeTerminal, safeText } from '../src/utils/sanitize';
import { renderTable } from '../src/utils/format';

const ESC = '\u001b';

test('safeText strips escape sequences, C0/C1, CR/LF and bidi controls', () => {
    assert.equal(safeText(`Kits${ESC}]52;c;ZXZpbA==${'\u0007'}`), 'Kits', 'OSC 52 clipboard write');
    assert.equal(safeText(`a${ESC}]8;;https://evil${ESC}\\link${ESC}]8;;${ESC}\\b`), 'alinkb', 'OSC 8 hyperlink');
    assert.equal(safeText(`x${ESC}[2K${ESC}[1A✓ pushed`), 'x✓ pushed', 'erase line + cursor up');
    assert.equal(safeText('one\r\ntwo\tthree'), 'one two three');
    assert.equal(safeText('a\u009b31mb\u0085c'), 'abc', 'C1 CSI and NEL');
    assert.equal(safeText('gpj.‮exe'), 'gpj.exe', 'RLO');
    assert.equal(safeText('⁦x⁩‏'), 'x');
    assert.equal(safeText('Plain name — ünïcode 日本'), 'Plain name — ünïcode 日本');
    assert.equal(safeText(null), '');
    assert.equal(safeText(42), '42');
});

test('safeTerminal keeps the logger colours and line breaks, drops everything else', () => {
    const green = `${ESC}[32m✓${ESC}[0m`;
    assert.equal(safeTerminal(`${green} done\n`), `${green} done\n`);
    assert.equal(safeTerminal(`a\tb\nc`), 'a\tb\nc');
    assert.equal(safeTerminal(`name${ESC}[8mhidden\n`), 'namehidden\n', 'conceal (SGR 8) is not a logger colour');
    assert.equal(safeTerminal(`x\r✓ fake\n`), 'x✓ fake\n');
    assert.equal(safeTerminal(`${ESC}]0;title${'\u0007'}ok`), 'ok');
});

test('safeCell keeps a cell painted by the command but cleans the value', () => {
    assert.equal(safeCell(`${ESC}[31mGAP${ESC}[0m`), `${ESC}[31mGAP${ESC}[0m`);
    assert.equal(safeCell(`a\nb${ESC}]52;c;x${'\u0007'}`), 'a b');
});

test('renderTable cells cannot drive the terminal', () => {
    const out = renderTable({ head: ['#', 'folder'], rows: [['1', `Kits${ESC}]52;c;ZXZpbA==${'\u0007'}\nfake row`]] });
    assert.ok(!out.includes(']52;'));
    assert.equal(out.split('\n').length, 3, 'header, rule, one row');
});

test('hasControlChars flags names a folder create/rename refuses', () => {
    assert.equal(hasControlChars('Kits/My kit'), false);
    assert.equal(hasControlChars(`a${ESC}[31m`), true);
    assert.equal(hasControlChars('a\nb'), true);
    assert.equal(hasControlChars('a‮b'), true);
});
