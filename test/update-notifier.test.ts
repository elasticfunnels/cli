import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isNewer, formatUpdateNotice, getUpdateNotice } from '../src/utils/updateNotifier';

test('isNewer compares releases numerically, not lexically', () => {
    assert.equal(isNewer('0.11.0', '0.10.0'), true);
    assert.equal(isNewer('0.10.0', '0.9.0'), true, 'two-digit minor beats one-digit');
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('0.10.1', '0.10.0'), true);
    assert.equal(isNewer('0.10.0', '0.10.0'), false, 'equal is not newer');
    assert.equal(isNewer('0.9.0', '0.10.0'), false, 'older is not newer');
    assert.equal(isNewer('v0.11.0', '0.10.0'), true, 'tolerates a leading v');
    assert.equal(isNewer('garbage', '0.10.0'), false, 'unparseable never nudges');
});

test('formatUpdateNotice names both versions and the install command', () => {
    const s = formatUpdateNotice('0.10.0', '0.11.0');
    assert.match(s, /0\.10\.0/);
    assert.match(s, /0\.11\.0/);
    assert.match(s, /npm i -g @elasticfunnels\/cli/);
});

test('getUpdateNotice stays silent for --json and --version (scriptable output)', () => {
    // stderr is not a TTY under the test runner, so this is doubly guaranteed —
    // but assert the flag gating explicitly regardless of environment.
    assert.equal(getUpdateNotice('0.10.0', ['node', 'ef', 'list', 'pages', '--json']), null);
    assert.equal(getUpdateNotice('0.10.0', ['node', 'ef', '--version']), null);
});

test('getUpdateNotice stays silent when NO_UPDATE_NOTIFIER is set', () => {
    const prev = process.env.NO_UPDATE_NOTIFIER;
    process.env.NO_UPDATE_NOTIFIER = '1';
    try {
        assert.equal(getUpdateNotice('0.10.0', ['node', 'ef', 'pull']), null);
    } finally {
        if (prev === undefined) delete process.env.NO_UPDATE_NOTIFIER; else process.env.NO_UPDATE_NOTIFIER = prev;
    }
});
