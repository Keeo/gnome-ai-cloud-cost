// SPDX-License-Identifier: GPL-3.0-or-later
// https://docs.nano-gpt.com/api-reference/endpoint/check-balance
// https://docs.nano-gpt.com/api-reference/endpoint/usage
import {money, ProviderError} from '../../provider-utils.js';

export const name = 'NanoGPT';
export const estimateFromBalance = true;

export function balance(key, fetch) {
    // This read-only endpoint requires POST; it uses the shared automatic retries.
    const data = fetch('https://api.nano-gpt.com/api/check-balance', key, {}, {
        authScheme: 'X-API-Key',
    });
    if (data?.error)
        throw new ProviderError('NanoGPT balance request rejected');
    // Nano is a separate currency balance, not USD credit. Never add it as dollars.
    try {
        return money(data?.usd_balance);
    } catch (_) {
        throw new ProviderError('NanoGPT USD credit balance unavailable');
    }
}

export function spend(_key, _now, _fetch) {
    // Usage is API-key-scoped and accepts UTC dates only, not a rolling hour.
    // Leave hourly spending to the collector's explicitly marked balance estimate.
    throw new ProviderError('NanoGPT hourly billing unavailable; use USD balance history');
}
