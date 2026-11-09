import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const STALE_AFTER_SECONDS = 600;
const COLLECT_INTERVAL_SECONDS = 180;
// Longer than the collector's 210s HTTP budget; collection runs outside Shell.
const COLLECT_TIMEOUT_SECONDS = 240;

function usd(value) {
    if (value === null || value === undefined)
        return '-';
    const number = Number(value);
    return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-';
}

function amount(value) {
    if (value === null || value === undefined)
        return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// Register only during enable(), not while extension.js is imported. Use a
// fresh GType name so a reloaded module never collides with the previous one.
function createIndicatorClass() {
    return GObject.registerClass({
    GTypeName: `CloudCostIndicator_${GLib.uuid_string_random().replaceAll('-', '')}`,
}, class CloudCostIndicator extends PanelMenu.Button {
    _init(directory, settings) {
        super._init(0.5, 'Cloud spending');
        this._bar = new St.BoxLayout({style_class: 'cloud-cost-bar'});
        this.add_child(this._bar);
        this._directory = directory;
        this._settings = settings;
        this._segments = {};
        this._rows = {};
        this._titles = {};
        this._ids = [];
        this._cancellable = new Gio.Cancellable();
        this._refreshing = false;
        this._refreshPending = false;
        this._destroyed = false;
        this._staleLabel = new St.Label({
            text: 'stale', visible: false, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cloud-cost-stale',
        });
        this._bar.add_child(this._staleLabel);

        this._whiteIconsItem = new PopupMenu.PopupSwitchMenuItem(
            'White provider icons', settings.get_boolean('force-white-icons'));
        this._whiteIconsItem.connect('toggled', (_item, state) => {
            settings.set_boolean('force-white-icons', state);
        });
        this.menu.addMenuItem(this._whiteIconsItem);
        this._settingsChangedId = settings.connect('changed::force-white-icons', () => {
            this._whiteIconsItem.setToggleState(settings.get_boolean('force-white-icons'));
            this._syncIcons();
        });
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._footer.label.text = 'Waiting for collector';
        this.menu.addMenuItem(this._footer);

        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncIcons() {
        // Retry missing files if the extension becomes active while its ZIP is unpacked.
        const filename = this._settings.get_boolean('force-white-icons')
            ? 'icon-white.svg' : 'icon.svg';
        for (const id of this._ids) {
            const segment = this._segments[id];
            const file = Gio.File.new_for_path(GLib.build_filenamev([
                this._directory, 'providers', id, filename,
            ]));
            if (segment.iconPath === file.get_path() && segment.icon.gicon instanceof Gio.FileIcon)
                continue;
            if (file.query_exists(null)) {
                segment.icon.gicon = new Gio.FileIcon({file});
                segment.iconPath = file.get_path();
            }
        }
    }

    _syncProviders(providers) {
        // Hide providers without a key. An inaccessible keyring leaves
        // configured unknown, so its error remains visible in the menu.
        const ids = Object.keys(providers).filter(id =>
            /^[a-z][a-z0-9_-]*$/.test(id) && providers[id]?.configured !== false).sort();
        if (ids.join('\0') === this._ids.join('\0')) {
            this._syncIcons();
            return;
        }
        for (const id of this._ids) {
            this._segments[id].group.destroy();
            this._rows[id].destroy();
        }
        this._ids = ids;
        this._segments = {};
        this._rows = {};
        for (const [index, id] of ids.entries()) {
            const group = new St.BoxLayout({style_class: 'cloud-cost-provider'});
            const icon = new St.Icon({
                icon_name: 'dialog-question-symbolic', icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'cloud-cost-icon',
            });
            group.add_child(icon);
            const credit = new St.Label({text: '-', y_align: Clutter.ActorAlign.CENTER});
            const rate = new St.Label({text: '-', y_align: Clutter.ActorAlign.CENTER});
            const dot = new St.Label({
                text: '·', y_align: Clutter.ActorAlign.CENTER, style_class: 'cloud-cost-dot',
            });
            group.add_child(credit);
            group.add_child(dot);
            group.add_child(rate);
            this._bar.insert_child_at_index(group, index);
            this._segments[id] = {group, icon, credit, dot, rate};
            const row = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            this.menu.addMenuItem(row, index);
            this._rows[id] = row;
        }
        this._syncIcons();
    }

    _updatePanel(providers, stale) {
        for (const id of this._ids) {
            const row = providers[id] ?? {};
            const credit = stale ? null : amount(row.balance);
            const spend = stale ? null : amount(row.last_hour_spend);
            const segment = this._segments[id];
            segment.credit.text = credit === null ? '-' : `$${Math.floor(credit)}`;
            // Hide negligible reported spending, never unavailable spending.
            const negligible = spend !== null && spend < 0.001;
            segment.dot.visible = !negligible;
            segment.rate.visible = !negligible;
            segment.rate.text = spend === null ? '-' :
                `${row.spend_source === 'balance_estimate' ? '≈' : ''}$${(Math.ceil(spend * 10) / 10).toFixed(1)}/h`;
            segment.rate.remove_style_class_name('cloud-cost-rate-warning');
            segment.rate.remove_style_class_name('cloud-cost-rate-danger');
            // Compare unrounded values so the display rounding does not trigger an alert.
            if (spend !== null && credit !== null && spend > 0 &&
                (credit <= 0 || spend > credit * 0.05)) {
                segment.rate.add_style_class_name('cloud-cost-rate-danger');
            } else if (spend !== null && spend > 1) {
                segment.rate.add_style_class_name('cloud-cost-rate-warning');
            }
        }
        this._staleLabel.text = this._ids.length ? 'stale' : 'Cloud Cost';
        this._staleLabel.visible = stale || this._ids.length === 0;
    }

    _refresh() {
        if (this._destroyed)
            return;
        if (this._refreshing) {
            this._refreshPending = true;
            return;
        }
        this._refreshing = true;
        const path = GLib.build_filenamev([GLib.get_user_cache_dir(),
            'gnome-cloud-cost', 'status.json']);
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(this._cancellable, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (this._destroyed)
                    return;
                if (!ok)
                    throw new Error('Cannot read status file');
                this._showStatus(JSON.parse(new TextDecoder().decode(contents)));
            } catch (_error) {
                if (!this._destroyed)
                    this._showUnavailable();
            } finally {
                this._refreshing = false;
                if (this._refreshPending && !this._destroyed) {
                    this._refreshPending = false;
                    this._refresh();
                }
            }
        });
    }

    _showUnavailable() {
        this._updatePanel({}, true);
        for (const id of this._ids)
            this._rows[id].label.text = `${this._titles[id] ?? id}: - (unavailable)`;
        this._footer.label.text = 'No collector data (see project setup instructions)';
    }

    _showStatus(status) {
        const updated = Date.parse(status.updated_at);
        const age = (Date.now() - updated) / 1000;
        const stale = !Number.isFinite(age) || age < -60 || age > STALE_AFTER_SECONDS;
        const providers = status.providers && typeof status.providers === 'object' &&
            !Array.isArray(status.providers) ? status.providers : {};
        this._syncProviders(providers);
        this._updatePanel(providers, stale);
        for (const id of this._ids) {
            const row = providers[id] ?? {};
            const title = typeof row.name === 'string' ? row.name : id;
            this._titles[id] = title;
            const spend = `${row.spend_source === 'balance_estimate' ? '≈' : ''}${usd(row.last_hour_spend)}`;
            let text = `${title}: ${usd(row.balance)} credit · ${spend} last 1h`;
            const errors = [row.balance_error, row.spend_error, row.spend_note].filter(Boolean);
            if (errors.length)
                text += ` (${[...new Set(errors)].join('; ')})`;
            this._rows[id].label.text = text;
        }
        this._footer.label.text = Object.values(providers).every(row => row?.configured === false)
            ? 'Add provider keys using secret-tool (see project URL)'
            : Number.isFinite(age)
                ? `${stale ? 'Stale · ' : ''}Updated ${new Date(updated).toLocaleTimeString()}`
                : 'Invalid update time';
    }

    destroy() {
        this._destroyed = true;
        this._settings.disconnect(this._settingsChangedId);
        this._cancellable.cancel();
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        super.destroy();
    }
});
}

export default class CloudCostExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new (createIndicatorClass())(this.path, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._collect();
        this._collectTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            COLLECT_INTERVAL_SECONDS, () => {
                this._collect();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _collect() {
        // Never pass credentials through Shell, argv, environment, or IPC.
        if (this._collector)
            return;
        try {
            const path = GLib.build_filenamev([this.path, 'collector.js']);
            const process = Gio.Subprocess.new(['gjs', '-m', path],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._collector = process;
            this._watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                COLLECT_TIMEOUT_SECONDS, () => {
                    process.force_exit();
                    this._watchdog = 0;
                    return GLib.SOURCE_REMOVE;
                });
            process.wait_async(null, (source, result) => {
                try {
                    source.wait_finish(result);
                    if (this._collector === process && !source.get_successful())
                        console.warn('Cloud Cost collector failed; check dependencies and cache permissions');
                } catch (_) {
                    // Never log provider exceptions, which could contain response data.
                }
                if (this._collector !== process)
                    return;
                this._collector = null;
                if (this._watchdog) {
                    GLib.Source.remove(this._watchdog);
                    this._watchdog = 0;
                }
                this._indicator?._refresh();
            });
        } catch (_) {
            console.warn('Cloud Cost collector could not start; check GJS installation');
            // The existing status will expire and the panel will mark it stale.
        }
    }

    disable() {
        if (this._collectTimer) {
            GLib.Source.remove(this._collectTimer);
            this._collectTimer = 0;
        }
        if (this._watchdog) {
            GLib.Source.remove(this._watchdog);
            this._watchdog = 0;
        }
        this._collector?.force_exit();
        this._collector = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
