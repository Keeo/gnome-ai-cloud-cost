// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
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
    equal(options.timeoutSeconds, 30);
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
equal(row.spend_source, 'balance_pending');
equal(row.spend_error, null);
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
equal(row.spend_source, 'balance_pending');
equal(row.spend_error, null);
row = run(deniedBilling, () => KEY, [{time: '2026-01-02T11:30:00Z', balance: '-1.88'}]);
equal(row.last_hour_spend, '0.5');
equal(row.spend_source, 'balance_estimate');
equal(row.spend_error, null);
equal(row.spend_note, null);
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
    const session = {timeout: 15, send_and_read(message) {
        sent = true;
        equal(message.method, method);
        equal(message.request_headers.get_one('Authorization'), `${scheme} ${KEY}`);
        equal(message.request_headers.get_one('Accept'), 'application/json');
        if (payload !== null)
            equal(message.request_headers.get_content_type()[0], 'application/json');
        Object.defineProperty(message, 'status_code', {value: 401});
        return new GLib.Bytes(new TextEncoder().encode(KEY));
    }};
    throws(() => fetchJson(session, 'https://example.com/billing', KEY, payload, options),
        'HTTP 401');
    assert(sent);
}
throws(() => fetchJson({}, 'https://example.com', KEY, null, {authScheme: KEY}),
    'Unsupported provider authentication scheme');

// Deterministic transport tests: real Soup messages, fake I/O and monotonic clock.
const originalSleep = GLib.usleep;
const originalClock = GLib.get_monotonic_time;
let clock = 0;
let delays = [];
GLib.get_monotonic_time = () => clock;
GLib.usleep = delay => { delays.push(delay); clock += delay; };
function transport(responses) {
    const messages = [];
    const timeouts = [];
    const session = {timeout: 15, send_and_read(message) {
        messages.push(message);
        timeouts.push(this.timeout);
        assert(responses.length, 'Too many requests');
        const response = responses.shift();
        if (response instanceof Error)
            throw response;
        Object.defineProperty(message, 'status_code', {value: response.status ?? 200});
        return new GLib.Bytes(new TextEncoder().encode(response.body ?? '{"ok":true}'));
    }};
    return {session, messages, timeouts};
}
const retryOptions = {authScheme: 'Key', timeoutSeconds: 30};
try {
    // Recover from a timeout and then a server error, without leaking request details.
    let mock = transport([new Error(KEY), {status: 503}, {}]);
    const data = fetchJson(mock.session, 'https://example.com/billing', KEY, null, retryOptions);
    equal(data.ok, true);
    equal(mock.messages.length, 3);
    equal(new Set(mock.messages).size, 3);
    equal(mock.timeouts.join(','), '30,30,30');
    equal(mock.session.timeout, 15);
    equal(delays.join(','), '1000000,2000000');
    for (const message of mock.messages)
        equal(message.request_headers.get_one('Authorization'), `Key ${KEY}`);

    // Defaults apply without options, to GETs and read-only POSTs alike.
    for (const payload of [null, {query: 'test'}]) {
        for (const response of [new Error(KEY), ...[408, 429, 500, 502, 504].map(status => ({status}))]) {
            mock = transport([response, {}]);
            equal(fetchJson(mock.session, 'https://example.com', KEY, payload).ok, true);
            equal(mock.messages.length, 2);
            equal(new Set(mock.messages).size, 2);
            equal(mock.session.timeout, 15);
            for (const message of mock.messages) {
                equal(message.method, payload === null ? 'GET' : 'POST');
                equal(message.request_headers.get_one('Authorization'), `Bearer ${KEY}`);
                if (payload !== null)
                    equal(message.request_headers.get_content_type()[0], 'application/json');
            }
        }
        for (const status of [400, 401, 403, 404]) {
            mock = transport([{status}]);
            throws(() => fetchJson(mock.session, 'https://example.com', KEY, payload), `HTTP ${status}`);
            equal(mock.messages.length, 1);
            equal(mock.session.timeout, 15);
        }
        for (const response of [new Error(KEY), {status: 503}]) {
            mock = transport([response, response, response]);
            const before = delays.length;
            throws(() => fetchJson(mock.session, 'https://example.com', KEY, payload),
                response instanceof Error ? 'network or timeout' : 'HTTP 503');
            equal(mock.messages.length, 3);
            equal(delays.slice(before).join(','), '1000000,2000000');
            equal(mock.session.timeout, 15);
        }
        // Invalid JSON is not a transient transport failure.
        mock = transport([{body: KEY}]);
        throws(() => fetchJson(mock.session, 'https://example.com', KEY, payload), 'invalid JSON');
        equal(mock.messages.length, 1);
        equal(mock.session.timeout, 15);

        // The shared budget caps requests and backoff for both methods.
        mock = transport([{status: 503}]);
        const before = delays.length;
        throws(() => fetchJson(mock.session, 'https://example.com', KEY, payload,
            {deadline: clock + 1.5e6}), 'HTTP 503');
        equal(mock.timeouts[0], 1);
        equal(mock.messages.length, 1);
        equal(delays.length, before);
        equal(mock.session.timeout, 15);
        mock = transport([]);
        throws(() => fetchJson(mock.session, 'https://example.com', KEY, payload,
            {deadline: clock}), 'budget exhausted');
        equal(mock.messages.length, 0);
        equal(mock.session.timeout, 15);
    }

    // Recovery flows through collection without replacing the UI values with errors.
    mock = transport([
        new Error(KEY), {body: '{"credits":{"current_balance":24.5,"currency":"USD"}}'},
        {status: 502}, {body: JSON.stringify(page([event('2026-01-02T12:00:00Z', 0.2)]))},
    ]);
    row = run((...args) => fetchJson(mock.session, ...args));
    equal(row.balance, '24.5');
    equal(row.last_hour_spend, '0.2');
    equal(row.balance_error, null);
    equal(row.spend_error, null);
    equal(mock.session.timeout, 15);
    assert(!JSON.stringify(row).includes(KEY), 'Key leaked into status');
} finally {
    GLib.usleep = originalSleep;
    GLib.get_monotonic_time = originalClock;
}

print('fal.ai and HTTP tests passed');
