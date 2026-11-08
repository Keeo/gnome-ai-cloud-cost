#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$root/dist}"
mkdir -p "$out"
gnome-extensions pack --force --out-dir="$out" \
    --extra-source="$root/extension/collector.js" \
    --extra-source="$root/extension/collector-core.js" \
    --extra-source="$root/extension/provider-utils.js" \
    --extra-source="$root/extension/provider-http.js" \
    --extra-source="$root/extension/provider-loader.js" \
    --extra-source="$root/extension/providers" \
    --extra-source="$root/LICENSE" \
    --schema="$root/extension/schemas/org.gnome.shell.extensions.cloud-cost.gschema.xml" \
    "$root/extension"
zip="$out/cloud-cost@keeo.github.io.shell-extension.zip"
for file in metadata.json extension.js stylesheet.css collector.js collector-core.js \
    provider-utils.js provider-http.js provider-loader.js LICENSE \
    schemas/org.gnome.shell.extensions.cloud-cost.gschema.xml; do
    unzip -Z1 "$zip" | grep -Fxq "$file" || { echo "Missing from ZIP: $file" >&2; exit 1; }
done
for folder in "$root"/extension/providers/*; do
    [[ -d "$folder" ]] || continue
    id="${folder##*/}"
    [[ "$id" =~ ^[a-z][a-z0-9_-]*$ ]] || continue
    for file in provider.js icon.svg icon-white.svg; do
        unzip -Z1 "$zip" | grep -Fxq "providers/$id/$file" || {
            echo "Missing from ZIP: providers/$id/$file" >&2; exit 1;
        }
    done
done
printf 'Ready: %s\n' "$zip"
