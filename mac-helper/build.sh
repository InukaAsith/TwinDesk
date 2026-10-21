#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds mac-helper with swiftc directly (SwiftPM's manifest API is broken in the installed
# Command Line Tools). Output: .build/release/macshare-helper, macshare-dockstub and macshare-calls
set -e
cd "$(dirname "$0")"
mkdir -p .build/release
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  -I Sources/VirtualDisplayBridge/include \
  -framework CoreGraphics -framework AppKit -framework ApplicationServices -framework IOKit -framework ScreenCaptureKit -framework CoreMedia -framework NetFS -framework CoreBluetooth -framework CoreWLAN -framework CoreLocation -lsqlite3 \
  Sources/macshare-helper/*.swift -o .build/release/macshare-helper
echo "built .build/release/macshare-helper"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" -framework AppKit \
  Sources/macshare-dockstub/main.swift -o .build/release/macshare-dockstub
echo "built .build/release/macshare-dockstub"
# The calls' sound over Bluetooth (mac/callaudio.js), its own process: only it loads IOBluetooth.
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" -framework IOBluetooth \
  Sources/macshare-calls/main.swift -o .build/release/macshare-calls
echo "built .build/release/macshare-calls"
# Share menu extension (packed into TwinDesk.app/Contents/PlugIns by mac/build-app.sh).
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" -application-extension -parse-as-library \
  -module-name MacShareShare -framework AppKit -Xlinker -e -Xlinker _NSExtensionMain \
  Sources/macshare-share/ShareViewController.swift -o .build/release/macshare-share
echo "built .build/release/macshare-share"
