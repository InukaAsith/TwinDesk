#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Rebuilds and signs TwinDesk's iOS shortcuts into web/shortcuts (needs a Mac signed in to iCloud).
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
python3 make.py "$tmp"
mkdir -p ../shortcuts
for f in "$tmp"/*.shortcut; do shortcuts sign --mode anyone --input "$f" --output "../shortcuts/$(basename "$f")"; done
chmod 644 ../shortcuts/*.shortcut
rm -rf "$tmp"
