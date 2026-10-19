#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Fetches adb for macOS (Android platform-tools) into mac/vendor/adb/adb. build-app.sh runs it,
# so the packaged app has adb for wireless debugging (mac/adb.js finds it there). A dev run can
# use the Android SDK's or Homebrew's adb instead. Needs curl and unzip (both ship with macOS).
set -e
cd "$(dirname "$0")/.."
DEST=vendor/adb
[ -x "$DEST/adb" ] && exit 0

TMP=$(mktemp -d "${TMPDIR:-/tmp}/twindesk-adb.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
echo "Downloading adb (Android platform-tools)…"
curl -fsSL -o "$TMP/platform-tools.zip" https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
unzip -q "$TMP/platform-tools.zip" -d "$TMP"
mkdir -p "$DEST"
cp "$TMP/platform-tools/adb" "$DEST/adb"
chmod +x "$DEST/adb"
for f in NOTICE.txt source.properties; do
  [ -f "$TMP/platform-tools/$f" ] && cp "$TMP/platform-tools/$f" "$DEST/$f"
done
echo "adb is in $DEST"
