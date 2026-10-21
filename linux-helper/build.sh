#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds bin/macshare-linuxhelper. Needs gcc and the X11 dev packages, and GLib for Bluetooth:
#   sudo apt install build-essential libx11-dev libxi-dev libxtst-dev libxrandr-dev libxfixes-dev libglib2.0-dev
# Without GLib it builds anyway, without Bluetooth (ble.c says so to every ble* command).
set -e
cd "$(dirname "$0")"
mkdir -p bin
BLE=""
if pkg-config --exists gio-2.0 2>/dev/null; then
  BLE="-DHAVE_BLE $(pkg-config --cflags --libs gio-2.0)"
else
  echo "gio-2.0 not found: building without Bluetooth (install libglib2.0-dev)" >&2
fi
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -std=gnu11 src/*.c -o bin/macshare-linuxhelper -lX11 -lXi -lXtst -lXrandr -lXfixes -lm -pthread $BLE
# Hosting Wi-Fi Direct beside the adapter's own network (linux/wifi.js; installed as root when it's first needed).
gcc -O2 -Wall -Wextra -std=gnu11 wifiap/wifiap.c -o bin/twindesk-wifiap
echo "built bin/macshare-linuxhelper bin/twindesk-wifiap"
