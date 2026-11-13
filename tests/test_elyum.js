// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import {collect} from '../extension/collector-core.js';
import {fetchJson} from '../extension/provider-http.js';
import {ProviderError} from '../extension/provider-utils.js';
import * as elyum from '../extension/providers/elyum/provider.js';

const KEY = 'private-test-elyum-key';
const NOW = new Date('2026-01-02T00:30:00Z');
const SAMPLE = [{time: '2026-01-01T23:30:00Z', balance: '4'}];
const providers = [{id: 'elyum', ...elyum}];

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
function account(usd = 3) {
    return {
        object: 'account', balance: {usd: 53, api_spendable: {usd}},
        plan: {code: 'pro', name: 'Pro'},
        key: {scopes: ['read'], spent_24h_usd: 1.42, remaining_24h_usd: 8.58, secret: KEY},
    };
}
let calls = 0;
function request(url, key, payload = null) {
    calls++;
    equal(url, 'https://api.elyum.ai/v1/account');
    equal(key, KEY);
    equal(payload, null); // GET; no render or other mutating request.
    return account();
}
function run(fetch = request, lookup = () => KEY, previous = []) {
    let saved;
    const status = collect(NOW, providers, lookup, fetch,
        id => { equal(id, 'elyum'); return previous; },
        (id, samples) => { equal(id, 'elyum'); saved = samples; });
    assert(!JSON.stringify(status).includes(KEY), 'Key or raw response leaked into cache');
    return {row: status.providers.elyum, saved};
}

equal(elyum.name, 'Elyum');
equal(elyum.estimateFromBalance, true);
// Show API funds, not total studio balance, key cap, or rolling-24h usage.
equal(elyum.balance(KEY, request), 3);
for (const value of ['0', 0, '-0.5', '10.25', 12.25])
    equal(elyum.balance(KEY, () => account(value)), Number(value));
for (const value of [null, '', ' ', 'NaN', Infinity, true, {}, []])
    throws(() => elyum.balance(KEY, () => account(value)), 'USD credit balance unavailable');
for (const data of [null, {}, [], {object: 'generation'},
    {object: 'account'}, {object: 'account', balance: {usd: 53}},
    {object: 'account', balance: {usd: 53, api_spendable: {}}},
    {object: 'account', balance: {usd: 53, api_spendable: {nano: 3}}},
    {balance: {api_spendable: {usd: 3}}}])
    throws(() => elyum.balance(KEY, () => data), 'USD credit balance unavailable');
for (const error of [1, KEY, {message: KEY, fix: KEY}])
    throws(() => elyum.balance(KEY, () => ({...account(), error})), 'balance request rejected');
throws(() => elyum.spend(KEY, NOW, () => { throw new Error('Must not request per-key 24h usage'); }),
    'hourly billing unavailable');

calls = 0;
let {row, saved} = run();
equal(calls, 1);
equal(row.configured, true);
equal(row.balance, '3');
equal(row.balance_error, null);
equal(row.last_hour_spend, null);
equal(row.spend_source, 'balance_pending');
equal(row.spend_error, null);
equal(saved.length, 1);
equal(saved[0].balance, '3');
equal(saved[0].time, '2026-01-02T00:30:00Z');

// Explicitly approximate, account-level API balance estimates across UTC midnight.
({row, saved} = run(request, () => KEY, SAMPLE));
equal(row.last_hour_spend, '1');
equal(row.spend_source, 'balance_estimate');
equal(row.spend_error, null);
equal(row.spend_note, null);
equal(saved.length, 2);
row = run(() => account(4), () => KEY, SAMPLE).row;
equal(row.last_hour_spend, '0');
equal(row.spend_source, 'balance_estimate');
({row, saved} = run(() => account(10), () => KEY, SAMPLE));
equal(row.last_hour_spend, null);
equal(saved.length, 1); // Top-ups reset the window rather than yielding negative spend.
for (const history of [[], [{time: '2026-01-01T23:30:00', balance: '4'}]])
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
equal(row.balance_error, 'Elyum balance request rejected');
equal(row.last_hour_spend, null);

// Exercise real Soup method/headers with fake I/O; no real credentials in tests.
function transport(responses) {
    const messages = [];
    const session = {timeout: 15, send_and_read(message) {
        messages.push(message);
        equal(message.method, 'GET');
        equal(message.request_headers.get_one('Authorization'), `Bearer ${KEY}`);
        equal(message.request_headers.get_one('X-API-Key'), null);
        equal(message.request_headers.get_one('Accept'), 'application/json');
        const response = responses[Math.min(messages.length - 1, responses.length - 1)];
        if (response instanceof Error)
            throw response;
        Object.defineProperty(message, 'status_code', {value: response.status ?? 200});
        return new GLib.Bytes(new TextEncoder().encode(response.body ?? JSON.stringify(account())));
    }};
    return {session, messages};
}
let mock = transport([{}]);
row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
equal(row.balance, '3');
equal(row.last_hour_spend, '1');
equal(row.spend_source, 'balance_estimate');
equal(mock.messages.length, 1);
equal(mock.session.timeout, 15);
// Authentication/invalid JSON failures must not retry, or leak error bodies.
for (const response of [{status: 401, body: KEY}, {status: 403, body: KEY}, {body: KEY}]) {
    mock = transport([response]);
    row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
    equal(row.balance, null);
    equal(row.last_hour_spend, null);
    equal(mock.messages.length, 1);
    equal(mock.session.timeout, 15);
    assert(row.balance_error !== 'Unexpected provider response');
}
// Transient GET failure retries once before succeeding, with auth on each attempt.
mock = transport([{status: 503}, {}]);
row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
equal(row.balance, '3');
equal(row.last_hour_spend, '1');
equal(mock.messages.length, 2);
equal(mock.session.timeout, 15);
// Exhaustion keeps balance/spend unavailable, never a misleading zero or old estimate.
mock = transport([new Error(KEY)]);
row = run((...args) => fetchJson(mock.session, ...args), () => KEY, SAMPLE).row;
equal(row.balance, null);
equal(row.last_hour_spend, null);
equal(row.balance_error, 'Provider request failed (network or timeout)');
equal(mock.messages.length, 3);
equal(mock.session.timeout, 15);

print('Elyum tests passed');
