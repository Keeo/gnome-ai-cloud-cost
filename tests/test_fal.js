// SPDX-License-Identifier: GPL-3.0-or-later
import {collect} from '../extension/collector-core.js';
import {fetchJson} from '../extension/provider-http.js';
import {ProviderError} from '../extension/provider-utils.js';
import * as fal from '../extension/providers/fal/provider.js';

const NOW = new Date('2026-01-02T12:30:00Z');
const KEY = 'fal-test-key';
const provider = {id: 'fal', ...fal};
function assert(ok, message = 'Assertion failed') {
    if (!ok)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(actual === expected, `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(fn, message = null) {
    let error;
    try { fn(); } catch (caught) { error = caught; }
    assert(error instanceof Error, 'Expected an error');
    if (message !== null) {
        assert(error instanceof ProviderError, 'Expected a safe provider error');
        assert(error.message.includes(message), `Unexpected error: ${error.message}`);
    }
}
function page(events = [], cursor = null) {
    return {billing_events: events, has_more: cursor !== null, next_cursor: cursor};
}
function event(time, cost) {
    return {timestamp: time, cost_subtotal: 10, cost_discount: 9.9, cost_total: cost};
}
function request(url, key, payload, options) {
    equal(key, KEY);
    equal(payload, null);
    equal(options.authScheme, 'Key');
    if (url === 'https://api.fal.ai/v1/account/billing?expand=credits')
        return {credits: {current_balance: '24.5', currency: 'USD'}};
    assert(url.startsWith('https://api.fal.ai/v1/models/billing-events?limit=10000&'));
    assert(url.includes('start=2026-01-02T11%3A30%3A00Z'));
    assert(url.includes('end=2026-01-02T12%3A30%3A00Z'));
    return page([
        event('2026-01-02T11:30:00Z', '0.1'), // Inclusive start.
        event('2026-01-02T13:00:00+01:00', 0.2),
        event('2026-01-02T11:29:59Z', 10),
        event('2026-01-02T12:30:00Z', 10), // Exclusive end.
        event('2026-01-02T12:31:00Z', 10),
    ]);
}
function run(fetch = request, lookup = () => KEY, previous = []) {
    return collect(NOW, [provider], lookup, fetch,
        id => { equal(id, 'fal'); return previous; },
        (id, samples) => {
            equal(id, 'fal');
            assert(samples.length > 0);
            assert(!JSON.stringify(samples).includes(KEY), 'Key leaked into balance history');
        }).providers.fal;
}

let row = run();
equal(row.name, 'fal.ai');
equal(row.configured, true);
equal(row.balance, '24.5');
equal(row.last_hour_spend, '0.3');
equal(row.spend_source, 'billing');
equal(row.balance_error, null);
equal(row.spend_error, null);
equal(run(() => { throw new Error('Should not fetch'); }, () => null).configured, false);
equal(run(request, () => { throw new Error('Locked'); }).configured, null);
equal(fal.balance(KEY, () => ({credits: {current_balance: 0, currency: 'USD'}})), 0);
equal(fal.balance(KEY, () => ({credits: {current_balance: -2.38, currency: 'USD'}})), -2.38);
equal(fal.spend(KEY, NOW, () => page()), 0);

// Follow all pages with the same window, and safely encode opaque cursors.
let calls = 0;
const cursor = 'next+/=&?';
const total = fal.spend(KEY, NOW, (url, key, payload, options) => {
    request(url, key, payload, options);
    calls++;
    if (calls === 1) {
        assert(!url.includes('&cursor='));
        return page([event('2026-01-02T12:00:00Z', 0.1)], cursor);
    }
    assert(url.endsWith(`&cursor=${encodeURIComponent(cursor)}`));
    return page([event('2026-01-02T12:01:00Z', 0.2)]);
});
equal(calls, 2);
assert(Math.abs(total - 0.3) < 1e-12);

for (const data of [{}, {credits: {}}, {credits: {current_balance: 10, currency: 'EUR'}}])
    throws(() => fal.balance(KEY, () => data), 'USD credit balance unavailable');
for (const value of [null, undefined, '', 'NaN', Infinity])
    throws(() => fal.balance(KEY, () => ({credits: {current_balance: value, currency: 'USD'}})));
for (const value of [null, undefined, '', 'NaN', Infinity, -1])
    throws(() => fal.spend(KEY, NOW, () => page([event('2026-01-02T12:00:00Z', value)])));
throws(() => fal.spend(KEY, NOW, () => page([event('2026-01-02T12:00:00', 1)])));
for (const data of [null, {}, {billing_events: null}])
    throws(() => fal.spend(KEY, NOW, () => data), 'billing events unavailable');
for (const data of [
    {billing_events: []},
    {...page(), has_more: 'false'},
    {...page(), has_more: true},
    {...page(), has_more: true, next_cursor: ''},
    {...page(), has_more: true, next_cursor: 1},
    {...page(), next_cursor: 'unexpected'},
])
    throws(() => fal.spend(KEY, NOW, () => data), 'pagination is incomplete');
throws(() => fal.spend(KEY, NOW, () => page([], 'same')), 'repeated a cursor');
calls = 0;
throws(() => fal.spend(KEY, NOW, () => page([], String(++calls))), 'too many pages');
equal(calls, 5);

// A rejected or failed later page must never be published as a partial total.
calls = 0;
row = run((url, ...args) => {
    if (url.includes('/account/billing'))
        return request(url, ...args);
    if (++calls === 1)
        return page([event('2026-01-02T12:00:00Z', 1)], 'next');
    throw new Error(`Private response containing ${KEY}`);
});
equal(row.balance, '24.5');
equal(row.last_hour_spend, null);
equal(row.spend_source, null);
equal(row.spend_error, 'fal.ai billing unavailable; collecting ~1h of balance history');
assert(!JSON.stringify(row).includes(KEY), 'Key leaked into status');

// Keys that can read balance but not billing still provide an explicitly marked estimate.
const deniedBilling = (url, ...args) => {
    if (url.includes('/account/billing'))
        return {credits: {current_balance: -2.38, currency: 'USD'}};
    throw new ProviderError('HTTP 403 from provider');
};
row = run(deniedBilling);
equal(row.balance, '-2.38');
equal(row.last_hour_spend, null);
assert(row.spend_error.includes('collecting ~1h'));
row = run(deniedBilling, () => KEY, [{time: '2026-01-02T11:30:00Z', balance: '-1.88'}]);
equal(row.last_hour_spend, '0.5');
equal(row.spend_source, 'balance_estimate');
equal(row.spend_error, null);
assert(row.spend_note.includes('Estimate from balance changes'));
row = run(() => ({error: {message: KEY}}));
equal(row.balance, null);
equal(row.last_hour_spend, null);
equal(row.balance_error, 'fal.ai billing request rejected');
assert(!JSON.stringify(row).includes(KEY), 'Raw API error leaked into status');

// Exercise actual Soup request headers without network I/O or real credentials.
for (const [payload, options, scheme, method] of [
    [null, undefined, 'Bearer', 'GET'],
    [{query: 'test'}, undefined, 'Bearer', 'POST'],
    [null, {authScheme: 'Key'}, 'Key', 'GET'],
]) {
    let sent = false;
    const session = {send_and_read(message) {
        sent = true;
        equal(message.method, method);
        equal(message.request_headers.get_one('Authorization'), `${scheme} ${KEY}`);
        equal(message.request_headers.get_one('Accept'), 'application/json');
        if (payload !== null)
            equal(message.request_headers.get_content_type()[0], 'application/json');
        throw new Error(`Network error containing ${KEY}`);
    }};
    throws(() => fetchJson(session, 'https://example.com/billing', KEY, payload, options),
        'network or timeout');
    assert(sent);
}
throws(() => fetchJson({}, 'https://example.com', KEY, null, {authScheme: KEY}),
    'Unsupported provider authentication scheme');

print('fal.ai and HTTP tests passed');
