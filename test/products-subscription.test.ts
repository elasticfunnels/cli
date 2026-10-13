import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseSubscriptionSpec, payloadFromOpts } from '../src/commands/productCommands';
import { CliError } from '../src/utils/exit';

/** `--subscription` maps onto the SaveProduct fields a recurring bump needs (device-listicle had to use --file). */
test('--subscription unit[:N] sets is_subscription, frequency and unit', () => {
    assert.deepEqual(parseSubscriptionSpec('month'), { is_subscription: true, subscription_frequency: 1, subscription_frequency_unit: 'month' });
    assert.deepEqual(parseSubscriptionSpec('week:2'), { is_subscription: true, subscription_frequency: 2, subscription_frequency_unit: 'week' });
    assert.deepEqual(parseSubscriptionSpec('3:months'), { is_subscription: true, subscription_frequency: 3, subscription_frequency_unit: 'month' });
    assert.deepEqual(parseSubscriptionSpec('off'), { is_subscription: false });
});

test('--subscription rejects bad units, zero, and extra parts', () => {
    for (const bad of ['fortnight', 'month:0', 'month:2:3', '2', '', 'month:x']) {
        assert.throws(() => parseSubscriptionSpec(bad), CliError, bad);
    }
});

test('--trial-days goes with a subscription, never with off', () => {
    assert.deepEqual(payloadFromOpts({ subscription: 'month', trialDays: 7, price: 19 }), {
        is_subscription: true, subscription_frequency: 1, subscription_frequency_unit: 'month', subscription_trial_days: 7, price: 19,
    });
    assert.throws(() => payloadFromOpts({ subscription: 'off', trialDays: 7 }), CliError);
    assert.throws(() => payloadFromOpts({ trialDays: 1.5 }), CliError);
    assert.deepEqual(payloadFromOpts({ title: 'X' }), { title: 'X' }, 'no subscription keys unless asked');
});
