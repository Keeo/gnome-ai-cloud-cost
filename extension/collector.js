// SPDX-License-Identifier: GPL-3.0-or-later
// Run with `gjs -m collector.js` in a separate process. Credentials never enter GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret?version=1';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {collect} from './collector-core.js';
import {fetchJson} from './provider-http.js';
import {discoverProviders} from './provider-loader.js';

const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-cloud-cost']);
const statusPath = GLib.build_filenamev([cacheDir, 'status.json']);
const providersDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('providers').get_path();
const samplesPath = id => GLib.build_filenamev([cacheDir, `${id}-samples.json`]);
const session = new Soup.Session({timeout: 15, user_agent: 'CloudCost/1.0'});

function readJson(path) {
    const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
    if (!ok)
        throw new Error('Cannot read cache');
    return JSON.parse(new TextDecoder().decode(contents));
}

function publish(path, value) {
    if (GLib.mkdir_with_parents(cacheDir, 0o700) !== 0 || GLib.chmod(cacheDir, 0o700) !== 0)
        throw new Error('Cannot create private cache directory');
    const data = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    Gio.File.new_for_path(path).replace_contents(
        data, null, false, Gio.FileCreateFlags.PRIVATE, null);
    // Gio may preserve an existing file's mode on replacement.
    if (GLib.chmod(path, 0o600) !== 0)
        throw new Error('Cannot protect cache file');
}

function lookup(id) {
    // secret-tool store uses the generic Secret Service schema. A null lookup schema
    // matches the two attributes independently of the item's schema name.
    return Secret.password_lookup_sync(null,
        {service: 'gnome-cloud-cost', provider: id}, null)?.trim() ?? null;
}

async function main() {
    const providers = await discoverProviders(providersDir);
    const status = collect(new Date(), providers, lookup,
        (...args) => fetchJson(session, ...args),
        id => {
            try {
                return readJson(samplesPath(id));
            } catch (_) {
                return [];
            }
        }, (id, samples) => publish(samplesPath(id), samples));
    publish(statusPath, status);
}

try {
    await main();
} catch (_) {
    // A failure to publish is signalled by exit status, not an exception that might leak data.
    System.exit(1);
}
