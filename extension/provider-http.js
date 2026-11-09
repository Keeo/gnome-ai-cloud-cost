// SPDX-License-Identifier: GPL-3.0-or-later
// Used only in the separate collector process, never GNOME Shell.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {ProviderError} from './provider-utils.js';

// Retries are opt-in and GET-only: never replay a potentially mutating POST.
// The collector supplies a monotonic deadline shared by all its requests.
export function fetchJson(session, url, key, payload = null, {
    authScheme = 'Bearer', timeoutSeconds = session.timeout, retries = 0, deadline = Infinity,
} = {}) {
    if (!['Bearer', 'Key'].includes(authScheme))
        throw new ProviderError('Unsupported provider authentication scheme');
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60 ||
        !Number.isInteger(retries) || retries < 0 || retries > 2)
        throw new ProviderError('Unsupported provider request options');
    const originalTimeout = session.timeout;
    const maxRetries = payload === null ? retries : 0;
    try {
        for (let attempt = 0; ; attempt++) {
            const remaining = (deadline - GLib.get_monotonic_time()) / 1e6;
            if (remaining < 1)
                throw new ProviderError('Provider request budget exhausted');
            session.timeout = Math.min(timeoutSeconds, Math.floor(remaining));
            // Soup messages cannot be reused after sending.
            const message = Soup.Message.new(payload === null ? 'GET' : 'POST', url);
            if (!message)
                throw new ProviderError('Provider request failed');
            message.request_headers.append('Authorization', `${authScheme} ${key}`);
            message.request_headers.append('Accept', 'application/json');
            if (payload !== null)
                message.set_request_body_from_bytes('application/json',
                    new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));
            let contents;
            let failure;
            let retryable = true;
            try {
                contents = session.send_and_read(message, null);
            } catch (_) {
                // libsoup errors may contain request details; never show them or log the key.
                failure = new ProviderError('Provider request failed (network or timeout)');
            }
            if (!failure && (message.status_code < 200 || message.status_code >= 300)) {
                failure = new ProviderError(`HTTP ${message.status_code} from provider`);
                retryable = [408, 429].includes(message.status_code) || message.status_code >= 500;
            }
            if (!failure) {
                try {
                    return JSON.parse(new TextDecoder().decode(contents.get_data()));
                } catch (_) {
                    throw new ProviderError('Provider returned invalid JSON');
                }
            }
            // Back off for 1s then 2s, only if the budget leaves time for another request.
            const delay = 2 ** attempt;
            if (!retryable || attempt >= maxRetries ||
                deadline - GLib.get_monotonic_time() < (delay + 1) * 1e6)
                throw failure;
            GLib.usleep(delay * 1e6);
        }
    } finally {
        session.timeout = originalTimeout;
    }
}
