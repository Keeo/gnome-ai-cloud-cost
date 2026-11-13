// SPDX-License-Identifier: GPL-3.0-or-later
// https://fal.ai/docs/platform-apis/v1/account/billing
// https://fal.ai/docs/platform-apis/v1/models/billing-events
import {money, iso, timestamp, ProviderError} from '../../provider-utils.js';

export const name = 'fal.ai';
export const estimateFromBalance = true;

const API = 'https://api.fal.ai/v1';
const HOUR = 60 * 60 * 1000;
// Bound work in the synchronous collector; never publish a partial total.
const MAX_PAGES = 5;

function query(path, key, fetch) {
    const response = fetch(`${API}${path}`, key, null, {
        authScheme: 'Key', timeoutSeconds: 30,
    });
    if (response?.error)
        throw new ProviderError('fal.ai billing request rejected');
    return response;
}

function amount(value) {
    const result = money(value);
    if (result < 0)
        throw new ProviderError('fal.ai returned a negative amount');
    return result;
}

export function balance(key, fetch) {
    const credits = query('/account/billing?expand=credits', key, fetch)?.credits;
    if (credits?.currency !== 'USD')
        throw new ProviderError('fal.ai USD credit balance unavailable');
    // Accounts can be overdrawn even though the documented schema says minimum 0.
    return money(credits.current_balance);
}

export function spend(key, now, fetch) {
    const end = now.getTime();
    const start = end - HOUR;
    const path = '/models/billing-events?limit=10000' +
        `&start=${encodeURIComponent(iso(new Date(start)))}` +
        `&end=${encodeURIComponent(iso(now))}`;
    const cursors = new Set();
    let cursor = null;
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
        const data = query(path + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`),
            key, fetch);
        if (!Array.isArray(data?.billing_events))
            throw new ProviderError('fal.ai billing events unavailable');
        if (typeof data.has_more !== 'boolean' ||
            (data.has_more ? typeof data.next_cursor !== 'string' || !data.next_cursor.trim()
                : data.next_cursor !== null))
            throw new ProviderError('fal.ai billing pagination is incomplete');
        for (const event of data.billing_events) {
            const time = timestamp(event.timestamp);
            if (time >= start && time < end)
                total += amount(event.cost_total); // Final billed cost, after discounts, in USD.
        }
        if (!data.has_more)
            return total;
        cursor = data.next_cursor;
        if (cursors.has(cursor))
            throw new ProviderError('fal.ai billing pagination repeated a cursor');
        cursors.add(cursor);
    }
    throw new ProviderError('fal.ai billing response is incomplete (too many pages)');
}
