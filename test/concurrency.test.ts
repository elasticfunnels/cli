import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/utils/concurrency';

test('mapWithConcurrency preserves input order regardless of finish order', async () => {
    const items = [10, 30, 5, 20];
    const results = await mapWithConcurrency(items, 4, async (n) => {
        await new Promise(r => setTimeout(r, n));
        return n * 2;
    });
    assert.deepEqual(results, [20, 60, 10, 40]);
});

test('mapWithConcurrency caps the number of in-flight workers', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    const out = await mapWithConcurrency(items, 4, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 10));
        inFlight--;
        return n;
    });

    assert.equal(out.length, 20);
    assert.ok(peak <= 4, `expected peak in-flight <= 4, got ${peak}`);
    assert.ok(peak >= 2, `expected some parallelism (>=2), got ${peak}`);
});

test('mapWithConcurrency falls back to serial when concurrency <= 1', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5];
    const out = await mapWithConcurrency(items, 1, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return n;
    });
    assert.equal(peak, 1);
    assert.deepEqual(out, [1, 2, 3, 4, 5]);
});

test('mapWithConcurrency handles empty input without spawning workers', async () => {
    const out = await mapWithConcurrency([], 8, async () => 'never');
    assert.deepEqual(out, []);
});

test('mapWithConcurrency surfaces worker errors', async () => {
    await assert.rejects(
        () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
            if (n === 2) throw new Error('boom');
            return n;
        }),
        /boom/,
    );
});
