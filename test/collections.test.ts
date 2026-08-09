import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseFieldSpec } from '../src/commands/collections';
import { CliError, ExitCode } from '../src/utils/exit';

/**
 * `--field Name[:type[:required]]` is the whole reason `ef collections create`
 * is usable in one line. A silently-misparsed spec produces a collection whose
 * fields don't match the form pointing at it, which loses submissions quietly —
 * so bad input must be rejected loudly rather than coerced.
 */

test('a bare name defaults to an optional text field', () => {
    assert.deepEqual(parseFieldSpec('First name'), { name: 'First name', type: 'text', required: false });
});

test('type and required are positional and optional', () => {
    assert.deepEqual(parseFieldSpec('Email:email'), { name: 'Email', type: 'email', required: false });
    assert.deepEqual(parseFieldSpec('Email:email:required'), { name: 'Email', type: 'email', required: true });
});

test('whitespace and casing are tolerated', () => {
    assert.deepEqual(parseFieldSpec('  Phone : TEXT : Required '), { name: 'Phone', type: 'text', required: true });
});

/** assert.throws() returns undefined, so capture the error to inspect it. */
function caught(fn: () => unknown): CliError {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof CliError, `expected a CliError, got ${err}`);
        return err;
    }
    throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' });
}

test('an unknown type is rejected, and the error lists the valid ones', () => {
    const err = caught(() => parseFieldSpec('Email:mail'));
    assert.equal(err.code, ExitCode.Validation);
    assert.match(err.message, /email/, 'names the valid types so the fix is obvious');
    assert.match(err.message, /"mail"/, 'quotes what was actually passed');
});

test('a typo in the required flag is rejected rather than silently ignored', () => {
    // "requried" must not quietly become an optional field.
    const err = caught(() => parseFieldSpec('Email:email:requried'));
    assert.equal(err.code, ExitCode.Validation);
    assert.match(err.message, /requried/);
});

test('an empty name is rejected', () => {
    assert.throws(() => parseFieldSpec(''), CliError);
    assert.throws(() => parseFieldSpec(':email'), CliError);
});
