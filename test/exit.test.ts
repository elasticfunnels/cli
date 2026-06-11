import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CliError, ExitCode } from '../src/utils/exit';

test('ExitCode constants are stable and documented', () => {
    // Reviewed by tooling: any change here is a breaking API change for
    // callers that branch on exit codes (Claude Code, CI). Locked down.
    assert.equal(ExitCode.Ok, 0);
    assert.equal(ExitCode.Error, 1);
    assert.equal(ExitCode.Validation, 2);
    assert.equal(ExitCode.Auth, 3);
    assert.equal(ExitCode.Conflict, 4);
    assert.equal(ExitCode.Network, 5);
    assert.equal(ExitCode.Server, 6);
    assert.equal(ExitCode.NotFound, 7);
});

test('CliError carries the exit code and message', () => {
    const err = new CliError(ExitCode.Auth, 'no api key');
    assert.equal(err.code, ExitCode.Auth);
    assert.equal(err.message, 'no api key');
    assert.equal(err.name, 'CliError');
    assert.ok(err instanceof Error);
});
