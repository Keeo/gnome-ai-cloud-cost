// SPDX-License-Identifier: GPL-3.0-or-later
// Pure collection logic. The separate collector.js process supplies providers, keyring, HTTP and disk I/O.
import {money, dollars, iso, timestamp, ProviderError} from './provider-utils.js';

const HOUR = 60 * 60 * 1000;

// Called after every successful balance poll, including when billing succeeds.
// An increase clears the window: a smaller refill masked by charges cannot be detected.
export function recordBalance(now, amount, previous) {
    const end = now.getTime();
    let samples = [];
    if (Array.isArray(previous)) {
        try {
            const parsed = previous.map(row => ({time: timestamp(row.time), balance: money(row.balance)}))
                .sort((a, b) => a.time - b.time);
            // A future sample means the clock has moved backwards. Never reuse it.
            if (parsed.length && parsed.at(-1).time <= end)
                samples = parsed.filter(row => row.time >= end - 2 * HOUR);
        } catch (_) {
            samples = [];
        }
    }
    if (samples.length && (end <= samples.at(-1).time || amount > samples.at(-1).balance + 0.01))
        samples = [];
    samples.push({time: end, balance: amount});
    const target = end - HOUR;
    const nearest = samples.reduce((best, row) =>
        Math.abs(row.time - target) < Math.abs(best.time - target) ? row : best);
    return {
        samples: samples.map(row => ({time: iso(new Date(row.time)), balance: dollars(row.balance)})),
        estimate: Math.abs(nearest.time - target) <= 4 * 60 * 1000
            ? Math.max(0, nearest.balance - amount) : null,
    };
}

function safeError(error) {
    // Never put an arbitrary exception (which may include credentials or response data) in the cache.
    return error instanceof ProviderError ? error.message : 'Unexpected provider response';
}

export function collect(now, providers, lookup, fetch, readSamples, writeSamples) {
    const status = {updated_at: iso(now), providers: {}};
    for (const provider of providers) {
        const row = {
            name: provider.name, configured: null, balance: null, last_hour_spend: null,
            balance_error: null, spend_error: null, spend_source: null, spend_note: null,
        };
        status.providers[provider.id] = row;
        let key;
        try {
            key = lookup(provider.id);
        } catch (_) {
            row.balance_error = row.spend_error = 'Cannot access Secret Service (is GNOME Keyring unlocked?)';
            continue;
        }
        if (!key) {
            row.configured = false;
            row.balance_error = row.spend_error = `No ${provider.name} key in GNOME Keyring`;
            continue;
        }
        row.configured = true;
        let balance = null;
        try {
            balance = money(provider.balance(key, fetch));
            row.balance = dollars(balance);
        } catch (error) {
            row.balance_error = safeError(error);
        }
        let estimate = null;
        if (provider.estimateFromBalance && balance !== null) {
            try {
                const history = recordBalance(now, balance, readSamples(provider.id));
                writeSamples(provider.id, history.samples);
                estimate = history.estimate;
            } catch (_) {
                // Billing may still work even if history cannot be saved.
            }
        }
        try {
            row.last_hour_spend = dollars(money(provider.spend(key, now, fetch)));
            row.spend_source = 'billing';
        } catch (error) {
            if (estimate !== null) {
                row.last_hour_spend = dollars(estimate);
                row.spend_source = 'balance_estimate';
                // The UI marks estimates with ≈; no long explanatory menu suffix needed.
            } else if (provider.estimateFromBalance && balance !== null) {
                // An unavailable bill is expected while balance history is warming up.
                // Keep the unavailable spend as '-', without a wide menu error message.
                row.spend_source = 'balance_pending';
            } else {
                row.spend_error = safeError(error);
            }
        }
    }
    return status;
}
