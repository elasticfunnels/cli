import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatBytes, formatRelative, renderTable } from '../src/utils/format';

test('formatBytes covers each unit boundary', () => {
    assert.equal(formatBytes(null), '-');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1024 * 1024), '1.00 MB');
    assert.equal(formatBytes(1024 * 1024 * 1024 * 3), '3.00 GB');
});

test('formatRelative handles missing input and recent timestamps', () => {
    assert.equal(formatRelative(undefined), '-');
    assert.equal(formatRelative(null), '-');
    assert.equal(formatRelative('not-a-date'), 'not-a-date');
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    assert.match(formatRelative(oneMinuteAgo), /(60s|\dm) ago/);
});

test('renderTable produces aligned columns and a separator row', () => {
    const out = renderTable({
        head: ['#', 'name', 'status'],
        rows: [
            ['1', 'home', 'published'],
            ['10', 'longer-slug-here', 'draft'],
        ],
    });
    const lines = out.split('\n');
    assert.equal(lines.length, 4, '1 header + 1 sep + 2 rows');
    // Each row must have the same length so the columns line up after padEnd.
    // Strip ANSI escape sequences (e.g. \u001B[1m...\u001B[0m) the `c.bold`
    // and `c.dim` helpers add — the visible rendered length must align.
    const stripped = lines.map(l => l.replace(/\u001B\[[0-9;]*m/g, ''));
    const widths = new Set(stripped.map(l => l.length));
    assert.equal(widths.size, 1, `expected aligned widths, got ${[...widths].join(',')}`);
});
