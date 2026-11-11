// SPDX-License-Identifier: GPL-3.0-or-later
// https://elyum.ai/open/docs#account
import {money, ProviderError} from '../../provider-utils.js';

export const name = 'Elyum';
export const estimateFromBalance = true;

export function balance(key, fetch) {
    const data = fetch('https://api.elyum.ai/v1/account', key, null, {retries: 2});
    if (data?.error)
        throw new ProviderError('Elyum balance request rejected');
    // The total also includes a studio-only plan allowance. Show API funds only,
    // not that allowance or the key's remaining rolling-24h spend cap.
    try {
        if (data?.object !== 'account')
            throw new Error('Not an account');
        return money(data?.balance?.api_spendable?.usd);
    } catch (_) {
        throw new ProviderError('Elyum API-spendable USD credit balance unavailable');
    }
}

export function spend(_key, _now, _fetch) {
    // The documented API has no hourly billing/list endpoint. spent_24h_usd is
    // key-scoped, not account-wide hourly spending; do not divide it by 24.
    throw new ProviderError('Elyum hourly billing unavailable; use API balance history');
}
