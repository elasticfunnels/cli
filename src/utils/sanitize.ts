/* eslint-disable no-control-regex -- this file exists to match control characters */
/**
 * Display sanitizers for text that came from the server (names, titles, paths
 * set by any brand collaborator) on its way to a human's terminal.
 *
 * A raw ESC lets that text drive the terminal: OSC 52 writes the clipboard,
 * OSC 8 plants hyperlinks, cursor moves and erases rewrite lines already
 * printed (a fake "✓ pushed"), and bidi controls reorder what is shown.
 * `--json` output is not touched: JSON.stringify escapes C0 itself and a
 * machine reader wants the exact value.
 */

const ESC_SEQ = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[ -/]*[0-~]?)/g;
const C1_SEQ = /[\u0090\u0098\u009d\u009e\u009f][^\u0007\u001b\u009c]*(?:\u0007|\u009c|\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]/g;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_KEEP_NL_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * One server-supplied value for display: escape sequences, C0/C1 controls,
 * CR/LF/tab and bidi controls removed (line breaks and tabs become a space),
 * so the value stays on its own line and cannot drive the terminal.
 */
export function safeText(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(ESC_SEQ, '')
        .replace(C1_SEQ, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(CONTROL, '')
        .replace(BIDI, '');
}

// Only the codes the logger's own `c` palette emits (reset, bold, dim, colours):
// no conceal (8) or other attributes a value could use to hide the text after it.
const SGR = /(\u001b\[(?:0|1|2|31|32|33|34|36)m)/;

function stripKeepLines(text: string): string {
    return text
        .replace(ESC_SEQ, '')
        .replace(C1_SEQ, '')
        .replace(CONTROL_KEEP_NL_TAB, '')
        .replace(BIDI, '');
}

/**
 * A whole log message on its way to stderr. Keeps the logger's own colours
 * (SGR `ESC[...m`, which can only change how text looks), line breaks and tabs;
 * strips every other escape sequence, the remaining C0/C1 controls (CR too, so
 * a value cannot rewind the line) and bidi controls.
 */
export function safeTerminal(msg: string): string {
    // split() with a capture group puts the SGR matches at odd indexes.
    return msg.split(SGR).map((part, i) => (i % 2 === 1 ? part : stripKeepLines(part))).join('');
}

/** True when a name holds characters a terminal would act on (controls, bidi). */
export function hasControlChars(value: string): boolean {
    return /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
}

/** {@link safeText} that keeps the logger's own colours: for a table cell a command may have painted. */
export function safeCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).split(SGR).map((part, i) => (i % 2 === 1 ? part : safeText(part))).join('');
}
