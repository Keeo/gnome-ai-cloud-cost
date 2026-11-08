// SPDX-License-Identifier: GPL-3.0-or-later
// Used only in the separate collector process, never GNOME Shell.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {ProviderError} from './provider-utils.js';

export function fetchJson(session, url, key, payload = null, {authScheme = 'Bearer'} = {}) {
    if (!['Bearer', 'Key'].includes(authScheme))
        throw new ProviderError('Unsupported provider authentication scheme');
    const message = Soup.Message.new(payload === null ? 'GET' : 'POST', url);
    if (!message)
        throw new ProviderError('Provider request failed');
    message.request_headers.append('Authorization', `${authScheme} ${key}`);
    message.request_headers.append('Accept', 'application/json');
    if (payload !== null)
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));
    let contents;
    try {
        contents = session.send_and_read(message, null);
    } catch (_) {
        // libsoup errors may contain request details; never show them or log the key.
        throw new ProviderError('Provider request failed (network or timeout)');
    }
    if (message.status_code < 200 || message.status_code >= 300)
        throw new ProviderError(`HTTP ${message.status_code} from provider`);
    try {
        return JSON.parse(new TextDecoder().decode(contents.get_data()));
    } catch (_) {
        throw new ProviderError('Provider returned invalid JSON');
    }
}
