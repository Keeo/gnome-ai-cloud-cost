// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import {collect} from '../extension/collector-core.js';
import {fetchJson} from '../extension/provider-http.js';
import {ProviderError} from '../extension/provider-utils.js';
import * as nanogpt from '../extension/providers/nanogpt/provider.js';

const KEY = 'private-test-nanogpt-key';
const NOW = new Date('2026-01-02T00:30:00Z');
const SAMPLE = [{time: '2026-01-01T23:30:00Z', balance: '130'}];
const providers = [{id: 'nanogpt', ...nanogpt}];

function assert(ok, message = 'Assertion failed') {
    if (!ok)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(actual === expected, `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(fn, message) {
    try {
        fn();
    } catch (error) {
        assert(error instanceof ProviderError, 'Expected a safe provider error');
        assert(error.message.includes(message), `Unexpected error: ${error.message}`);
        assert(!error.message.includes(KEY), 'Key leaked into error');
        return;
    }
    throw new Error('Expected failure');
}

let calls = 0;
function request(url, key, payload, options) {
    calls++;
    equal(url, 'https://api.nano-gpt.com/api/check-balance');
    equal(key, KEY);
    equal(JSON.stringify(payload), '{}'); // POST, not the default GET.
    equal(options.authScheme, 'X-API-Key');
    return {usd_balance: '129.46956147', nano_balance: '26.71801147', nanoDepositAddress: KEY};
}
function run(fetch = request, lookup = () => KEY, previous = []) {
    let saved;
    const status = collect(NOW, providers, lookup, fetch,
        id => { equal(id, 'nanogpt'); return previous; },
        (id, samples) => { equal(id, 'nanogpt'); saved = samples; });
    assert(!JSON.stringify(status).includes(KEY), 'Key or raw response leaked into cache');
    return {row: status.providers.nanogpt, saved};
}

// USD credit only; never add the Nano currency balance or return deposit details.
equal(nanogpt.name, 'NanoGPT');
equal(nanogpt.estimateFromBalance, true);
equal(nanogpt.balance(KEY, request), 129.46956147);
for (const value of ['0', 0, '-0.5', 12.25])
    equal(nanogpt.balance(KEY, () => ({usd_balance: value})), Number(value));
for (const value of [null, undefined, '', ' ', 'NaN', Infinity, true, {}, []])
    throws(() => nanogpt.balance(KEY, () => ({usd_balance: value})), 'USD credit balance unavailable');
for (const data of [null, {}, [], {nano_balance: '10'}])
    throws(() => nanogpt.balance(KEY, () => data), 'USD credit balance unavailable');
for (const error of [1, KEY, {message: KEY}])
    throws(() => nanogpt.balance(KEY, () => ({error, message: KEY, usd_balance: '10'})),
        'balance request rejected');

// Never mislabel daily/per-key usage as an account-wide rolling-hour bill.
throws(() => nanogpt.spend(KEY, NOW, () => { throw new Error('Must not fetch daily usage'); }),
    'hourly billing unavailable');

calls = 0;
let {row, saved} = run();
equal(calls, 1);
equal(row.configured, true);
equal(row.balance, '129.46956147');
equal(row.balance_error, null);
equal(row.last_hour_spend, null);
equal(row.spend_source, 'balance_pending');
equal(row.spend_error, null);
equal(saved.length, 1);
equal(saved[0].balance, '129.46956147');
equal(saved[0].time, '2026-01-02T00:30:00Z');

// Estimates span UTC midnight, remain explicitly approximate, and can be zero.
({row, saved} = run(request, () => KEY, SAMPLE));
assert(Math.abs(Number(row.last_hour_spend) - 0.53043853) < 1e-10);
equal(row.spend_source, 'balance_estimate');
equal(row.spend_error, null);
equal(row.spend_note, null);
equal(saved.length, 2);
row = run(() => ({usd_balance: '130'}), () => KEY, SAMPLE).row;
equal(row.last_hour_spend, '0');
equal(row.spend_source, 'balance_estimate');
({row, saved} = run(() => ({usd_balance: '140'}), () => KEY, SAMPLE));
equal(row.last_hour_spend, null);
equal(saved.length, 1); // Refills reset the estimate rather than yielding negative spend.
for (const history of [[], [{time: '2026-01-01T23:30:00', balance: '130'}]])
    equal(run(request, () => KEY, history).row.last_hour_spend, null);

const noFetch = () => { throw new Error('Must not request an unconfigured provider'); };
row = run(noFetch, () => null).row;
equal(row.configured, false);
equal(row.balance, null);
equal(row.last_hour_spend, null);
row = run(noFetch, () => { throw new Error(KEY); }).row;
equal(row.configured, null);
assert(row.balance_error.includes('Secret Service'));
row = run(() => { throw new Error(KEY); }, () => KEY, SAMPLE).row;
equal(row.balance, null);
equal(row.balance_error, 'Unexpected provider response');
equal(row.last_hour_spend, null);
row = run(() => ({error: {message: KEY}}), () => KEY, SAMPLE).row;
equal(row.balance_error, 'NanoGPT balance request rejected');
equal(row.last_hour_spend, null);

// Exercise actual Soup headers and method with fake I/O, never real credentials.
function transport(responses) {
    const messages = [];
    const session = {timeout: 15, send_and_read(message) {
        messages.push(message);
        equal(message.method, 'POST');
        equal(message.request_headers.get_one('X-API-Key'), KEY);
        equal(message.request_headers.get_one('Authorization'), null);
        equal(message.request_headers.get_one('Accept'), 'application/json');
        equal(message.request_headers.get_content_type()[0], 'application/json');
        const response = responses[Math.min(messages.length - 1, responses.length - 1)];
        if (response instanceof Error)
            throw response;
        Object.defineProperty(message, 'status_code', {value: response.status ?? 200});
        return new GLib.Bytes(new TextEncoder().encode(response.body ?? '{"usd_balance":"129.5"}'));
    }};
    return {session, messages};
}
const originalSleep = GLib.usleep;
const delays = [];
GLib.usleep = delay => { delays.push(delay); };
try {
    let mock = transport([{}]);
    row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
    equal(row.balance, '129.5');
    equal(row.last_hour_spend, '0.5');
    equal(row.spend_source, 'balance_estimate');
    equal(mock.messages.length, 1);
    equal(mock.session.timeout, 15);
    for (const response of [{status: 401}, {status: 403}, {body: KEY}]) {
        mock = transport([response]);
        row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
        equal(row.balance, null);
        equal(row.last_hour_spend, null);
        equal(mock.messages.length, 1);
        equal(mock.session.timeout, 15);
        assert(row.balance_error !== 'Unexpected provider response');
    }
    // The actual NanoGPT POST recovers automatically; no provider retry opt-in.
    for (const response of [new Error(KEY), {status: 408}, {status: 429}, {status: 503}]) {
        mock = transport([response, response, {}]);
        const before = delays.length;
        row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
        equal(row.balance, '129.5');
        equal(row.balance_error, null);
        equal(row.last_hour_spend, '0.5');
        equal(row.spend_source, 'balance_estimate');
        equal(mock.messages.length, 3);
        equal(new Set(mock.messages).size, 3);
        equal(delays.slice(before).join(','), '1000000,2000000');
        equal(mock.session.timeout, 15);
    }
    // Exhaustion remains unavailable, without publishing stale balances or raw errors.
    for (const response of [new Error(KEY), {status: 429}, {status: 503}]) {
        mock = transport([response]);
        row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
        equal(row.balance, null);
        equal(row.last_hour_spend, null);
        equal(mock.messages.length, 3);
        equal(mock.session.timeout, 15);
        equal(row.balance_error, response instanceof Error
            ? 'Provider request failed (network or timeout)'
            : `HTTP ${response.status} from provider`);
    }
} finally {
    GLib.usleep = originalSleep;
}

print('NanoGPT tests passed');
