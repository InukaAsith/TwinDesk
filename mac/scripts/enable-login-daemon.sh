#!/usr/bin/env bash
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Installs TwinDesk helper as a system LaunchDaemon so it can run before user login.
# Note: On macOS 12+, WindowServer blocks synthetic CGEvent injection into password fields at loginwindow;
# TwinDesk's Bluetooth HID peripheral emulation is recommended for hardware-level loginwindow control.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (e.g. sudo $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SRC="${SCRIPT_DIR}/../system/org.twindesk.helper.plist"
PLIST_DEST="/Library/LaunchDaemons/org.twindesk.helper.plist"

if [[ ! -f "${PLIST_SRC}" ]]; then
  echo "Error: Plist file not found at ${PLIST_SRC}" >&2
  exit 1
fi

echo "Installing LaunchDaemon to ${PLIST_DEST}..."
cp "${PLIST_SRC}" "${PLIST_DEST}"
chown root:wheel "${PLIST_DEST}"
chmod 644 "${PLIST_DEST}"

echo "Loading LaunchDaemon with launchctl..."
launchctl bootstrap system "${PLIST_DEST}" 2>/dev/null || launchctl load -w "${PLIST_DEST}" 2>/dev/null || true

echo "LaunchDaemon installed successfully."
