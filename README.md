# Cloud Cost for GNOME

A GNOME Shell 50 top-bar extension showing **OpenRouter**, **Runpod**, and **fal.ai** credit and spending over the last hour. Click the indicator for details and errors.

![Cloud Cost indicator in the GNOME top bar](image.png)

## Install

Download the ZIP from [GitHub Releases](https://github.com/Keeo/gnome-ai-cloud-cost/releases) or a [GitHub Actions](https://github.com/Keeo/gnome-ai-cloud-cost/actions) build. To build it yourself, run `bash ./pack.sh`; the ZIP will be in `dist/`.

```sh
gnome-extensions install dist/cloud-cost@keeo.github.io.shell-extension.zip
gnome-extensions enable cloud-cost@keeo.github.io
```

On Wayland, log out and back in if GNOME does not discover the new extension. Requires GNOME Shell 50, GJS with Secret 1 and Soup 3 typelibs, and GNOME Keyring (or another Secret Service).

### Upgrading from the old Python collector

If an earlier installation used a systemd timer, disable it before running this version:

```sh
systemctl --user disable --now gnome-cloud-cost.timer
```

The extension now runs its own bundled collector. The old Python collector writes to the same cache but only knows about OpenRouter and Runpod; leaving its timer active can make new provider rows disappear and reappear every few minutes.

## Add API keys

Run these commands **interactively**; `secret-tool` prompts for each key. Do not put keys on the command line or in tracked files.

```sh
secret-tool store --label='Cloud Cost: OpenRouter' service gnome-cloud-cost provider openrouter
secret-tool store --label='Cloud Cost: Runpod' service gnome-cloud-cost provider runpod
secret-tool store --label='Cloud Cost: fal.ai' service gnome-cloud-cost provider fal
```

OpenRouter requires a [management key](https://openrouter.ai/settings/management-keys), not an inference key. For fal.ai, create a key with the **BILLING** preset at [Dashboard → Keys](https://fal.ai/dashboard/keys) for balance and exact spending; an ordinary **API** key does not have billing access. A **FULL** key also works, but grants unnecessary permissions. A **READONLY** key can read the balance, with estimated spending after an hour of samples. fal.ai shows remaining USD credits (including negative balances) and sums final, after-discount [billing events](https://fal.ai/docs/platform-apis/v1/models/billing-events) from the preceding hour, following pagination; incomplete results are never shown as a partial total. Configure any combination of providers; providers without keys are hidden. If none is configured, the indicator shows “Cloud Cost” with setup instructions in its menu. Updates arrive within three minutes.

The bundled collector runs in a separate GJS process so API keys never enter GNOME Shell. It writes a private, key-free cache at `~/.cache/gnome-cloud-cost/`. Unavailable or stale values show `-`, not zero. If Runpod or fal.ai billing is unavailable, spending may show **≈** after an hour of balance samples; this is only an estimate.

Icons use colors from the [OpenRouter brand assets](https://openrouter.ai/brand) and [Runpod brand kit](https://www.runpod.io/brandkit), plus the fal.ai logo and lime color from its [official website](https://fal.ai/), by default. Select **White provider icons** in the indicator menu to use white icons on a dark panel instead; this choice persists across sessions. The logos have transparent backgrounds and are not automatically recolored by Shell.

## Add a provider

Create `extension/providers/<id>/` (lowercase letter followed by lowercase letters, digits, `_` or `-`) containing:

- `icon.svg` and `icon-white.svg`: transparent top-bar icons in the provider color and white, respectively. Use regular SVGs, not GNOME symbolic icons; Shell must not recolor them.
- `provider.js`: an ES module exporting `name` (display name), `balance(key, fetch)` (remaining credit in USD), and `spend(key, now, fetch)` (USD spent during the preceding hour). `now` is a `Date`; `fetch(url, key, payload?, options?)` returns parsed JSON and uses POST when given a payload. Authentication defaults to `Bearer`; pass `null` for a GET payload and `{authScheme: 'Key'}` as options for APIs such as fal.ai. See the existing folders for examples. Optionally export `estimateFromBalance = true` to fall back to an hour of balance samples when billing fails.

Store its key with `secret-tool store --label='Cloud Cost: <name>' service gnome-cloud-cost provider <id>` (run interactively), then run `bash ./pack.sh` and reinstall the ZIP. The collector discovers valid provider folders and publishes their results; the panel builds its rows and loads each folder's icon from the collector's key-free status. Neither collector nor panel nor pack script needs a per-provider edit. Avoid including keys or raw API responses in errors; unexpected errors are hidden from the status cache.

Development: `gjs -m tests/test_collector.js` and `gjs -m tests/test_fal.js` run the collector and fal.ai/HTTP tests. Source is [GPL-3.0-or-later](LICENSE). GitHub Actions builds the ZIP on PRs and pushes; `v*` tags attach it to a GitHub Release. Publishing to extensions.gnome.org is separate.
