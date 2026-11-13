// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {collect, recordBalance} from '../extension/collector-core.js';
import {discoverProviders} from '../extension/provider-loader.js';
import {fetchJson} from '../extension/provider-http.js';
import * as openrouter from '../extension/providers/openrouter/provider.js';
import * as runpod from '../extension/providers/runpod/provider.js';

const providers = [
    {id: 'openrouter', ...openrouter},
    {id: 'runpod', ...runpod},
];

const NOW = new Date('2026-01-02T12:30:00Z');
function assert(ok, message) {
    if (!ok)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(actual === expected, `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function fetch(url, key, payload = null) {
    assert(['or-key', 'rp-key'].includes(key), 'Unexpected key');
    if (url.endsWith('/credits'))
        return {data: {total_credits: 100, total_usage: 34.25}};
    if (url.endsWith('/analytics/query')) {
        equal(payload.granularity, 'minute');
        equal(payload.time_range.start, '2026-01-02T11:30:00Z');
        equal(payload.time_range.end, '2026-01-02T12:30:00Z');
        return {data: {metadata: {truncated: false}, data: [
            {total_usage: '0.1'}, {total_usage: '0.2'},
        ]}};
    }
    if (url.endsWith('/graphql')) {
        if (payload.query.includes('clientBalance'))
            return {data: {myself: {clientBalance: 10.5}}};
        return {data: {myself: {billing: {summary: [
            {time: '2026-01-02T12:00:00Z', gpuCloudAmount: 0.25, storageAmount: 0.03},
            {time: '2026-01-02T11:29:59Z', gpuCloudAmount: 10},
            {time: '2026-01-02T12:31:00Z', gpuCloudAmount: 10},
        ]}}}};
    }
    throw new Error('Unexpected URL');
}
function run(lookup = id => ({openrouter: 'or-key', runpod: 'rp-key'})[id],
    request = fetch, previous = []) {
    let saved;
    const status = collect(NOW, providers, lookup, request,
        id => { equal(id, 'runpod'); return previous; },
        (id, samples) => { equal(id, 'runpod'); saved = samples; });
    return {status, saved};
}

let {status, saved} = run();
equal(status.updated_at, '2026-01-02T12:30:00Z');
equal(status.providers.openrouter.balance, '65.75');
equal(status.providers.openrouter.last_hour_spend, '0.3');
equal(status.providers.runpod.name, 'Runpod');
equal(status.providers.runpod.balance, '10.5');
equal(status.providers.runpod.last_hour_spend, '0.28');
equal(saved.length, 1);

// All OpenRouter/Runpod endpoints inherit retries, including analytics/GraphQL POSTs.
const originalSleep = GLib.usleep;
const delays = [];
const attempts = new Map();
GLib.usleep = delay => { delays.push(delay); };
try {
    const request = (url, key, payload = null) => {
        const endpoint = `${url}:${JSON.stringify(payload)}`;
        const session = {timeout: 15, send_and_read(message) {
            equal(message.method, payload === null ? 'GET' : 'POST');
            equal(message.request_headers.get_one('Authorization'), `Bearer ${key}`);
            const attempt = (attempts.get(endpoint) ?? 0) + 1;
            attempts.set(endpoint, attempt);
            if (attempt === 1)
                throw new Error('Simulated timeout');
            Object.defineProperty(message, 'status_code', {value: attempt === 2 ? 503 : 200});
            return new GLib.Bytes(new TextEncoder().encode(attempt === 2
                ? '{}' : JSON.stringify(fetch(url, key, payload))));
        }};
        const result = fetchJson(session, url, key, payload);
        equal(session.timeout, 15);
        return result;
    };
    const recovered = run(undefined, request).status;
    equal(recovered.providers.openrouter.balance, '65.75');
    equal(recovered.providers.openrouter.last_hour_spend, '0.3');
    equal(recovered.providers.runpod.balance, '10.5');
    equal(recovered.providers.runpod.last_hour_spend, '0.28');
    equal(attempts.size, 4);
    for (const count of attempts.values())
        equal(count, 3);
    equal(delays.join(','), Array(4).fill('1000000,2000000').join(','));
    assert(!JSON.stringify(recovered).includes('-key'), 'Credentials leaked into status');
} finally {
    GLib.usleep = originalSleep;
}

status = run(id => id === 'runpod' ? null : 'or-key').status;
equal(status.providers.runpod.configured, false);
equal(status.providers.runpod.last_hour_spend, null);
equal(status.providers.openrouter.last_hour_spend, '0.3');

status = run(() => null).status;
equal(status.providers.openrouter.configured, false);
equal(status.providers.runpod.configured, false);

status = run(() => { throw new Error('Keyring locked'); }).status;
equal(status.providers.openrouter.configured, null);
equal(status.providers.runpod.configured, null);
assert(status.providers.openrouter.balance_error.includes('Secret Service'));

status = run(() => 'or-key', (url, key, payload) => {
    const response = fetch(url, key, payload);
    if (url.endsWith('/analytics/query'))
        response.data.metadata.truncated = true;
    return response;
}).status;
equal(status.providers.openrouter.last_hour_spend, null);
assert(status.providers.openrouter.spend_error.includes('incomplete'));

const sample = [{time: '2026-01-02T11:30:00Z', balance: '11'}];
status = run(() => 'rp-key', (url, key, payload) => {
    if (url.endsWith('/graphql') && payload.query.includes('billing('))
        return {errors: [{message: 'secret must not leak'}]};
    return fetch(url, key, payload);
}, sample).status;
equal(status.providers.runpod.last_hour_spend, '0.5');
equal(status.providers.runpod.spend_source, 'balance_estimate');
equal(status.providers.runpod.spend_note, null);
assert(!JSON.stringify(status).includes('secret'), 'Raw provider error leaked');

status = run(() => 'rp-key', (url, key, payload) => {
    if (url.endsWith('/graphql') && payload.query.includes('billing('))
        throw new Error('Billing unavailable');
    return fetch(url, key, payload);
}).status;
equal(status.providers.runpod.last_hour_spend, null);
equal(status.providers.runpod.spend_source, 'balance_pending');
equal(status.providers.runpod.spend_error, null);

const refill = recordBalance(new Date('2026-01-02T12:33:00Z'), 20, saved);
equal(refill.estimate, null);
equal(refill.samples.length, 1);
const broken = recordBalance(NOW, 9, [{time: '2026-01-02T11:30:00', balance: 10}]);
equal(broken.estimate, null);
equal(broken.samples.length, 1);
const backwards = recordBalance(NOW, 9, [
    {time: '2026-01-02T11:30:00Z', balance: 10},
    {time: '2026-01-02T12:31:00Z', balance: 9.5},
]);
equal(backwards.estimate, null);
equal(backwards.samples.length, 1);

// Discovery accepts new provider folders without changes to the collector or Shell.
const bundled = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('extension').get_child('providers').get_path();
const discovered = await discoverProviders(bundled);
equal(discovered.map(provider => provider.id).join(','), 'elyum,fal,nanogpt,openrouter,runpod');
const temp = Gio.File.new_for_path(GLib.dir_make_tmp('cloud-cost-test-XXXXXX'));
const extra = temp.get_child('custom');
extra.make_directory(null);
const moduleFile = extra.get_child('provider.js');
const iconFile = extra.get_child('icon.svg');
const whiteIconFile = extra.get_child('icon-white.svg');
const incomplete = temp.get_child('incomplete');
incomplete.make_directory(null);
try {
    moduleFile.replace_contents('export const name = "Custom"; export const balance = () => 12; export const spend = () => 0.5;',
        null, false, Gio.FileCreateFlags.NONE, null);
    iconFile.replace_contents('<svg xmlns="http://www.w3.org/2000/svg"/>',
        null, false, Gio.FileCreateFlags.NONE, null);
    // Both color modes must be available for every discovered provider.
    equal((await discoverProviders(temp.get_path())).length, 0);
    whiteIconFile.replace_contents('<svg xmlns="http://www.w3.org/2000/svg"/>',
        null, false, Gio.FileCreateFlags.NONE, null);
    const added = await discoverProviders(temp.get_path());
    equal(added.map(provider => provider.id).join(','), 'custom');
    const custom = collect(NOW, added, () => 'custom-key', () => { throw new Error('No HTTP needed'); },
        () => { throw new Error('No samples needed'); }, () => {});
    equal(custom.providers.custom.balance, '12');
    equal(custom.providers.custom.last_hour_spend, '0.5');
    equal(Object.keys(custom.providers).length, 1);
    const missing = collect(NOW, added, () => null, () => { throw new Error('Should not fetch'); },
        () => [], () => {});
    equal(missing.providers.custom.configured, false);
} finally {
    moduleFile.delete(null);
    iconFile.delete(null);
    whiteIconFile.delete(null);
    extra.delete(null);
    incomplete.delete(null);
    temp.delete(null);
}

print('Collector tests passed');
