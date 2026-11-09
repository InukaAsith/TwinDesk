#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds mac-helper with swiftc directly (SwiftPM's manifest API is broken in the installed
# Command Line Tools). Pass x64 or arm64 to cross-build; without an argument, use the host.
# Output: .build/release/macshare-helper, macshare-dockstub and macshare-calls
set -e
cd "$(dirname "$0")"
mkdir -p .build/release
ARCH=${1:-$(uname -m)}
case "$ARCH" in
  x64|x86_64) SWIFT_ARCH=x86_64 ;;
  arm64|aarch64) SWIFT_ARCH=arm64 ;;
  *) echo "Error: unsupported macOS architecture '$ARCH' (use x64 or arm64)." >&2; exit 2 ;;
esac
TARGET="$SWIFT_ARCH-apple-macos13.0"

# The input lane (native/tdfast, docs/protocol.md), when cargo is there: libtdfast.a for this arch,
# and the helpers built with -D TDFAST. Without cargo they build as before and Node keeps its own lane.
TDFAST=""
if [ -z "$TWINDESK_NO_TDFAST" ] && command -v cargo >/dev/null 2>&1; then
  RUST_TARGET="$SWIFT_ARCH-apple-darwin"
  [ "$SWIFT_ARCH" = arm64 ] && RUST_TARGET=aarch64-apple-darwin
  rustup target add "$RUST_TARGET" >/dev/null 2>&1 || true
  if MACOSX_DEPLOYMENT_TARGET=13.0 cargo build --release --manifest-path ../native/tdfast/Cargo.toml --target "$RUST_TARGET" --lib; then
    mkdir -p lib
    cp "../native/tdfast/target/$RUST_TARGET/release/libtdfast.a" lib/libtdfast.a
    TDFAST="-D TDFAST -I ../native/tdfast/include -L lib -ltdfast"
    echo "the input lane: native (lib/libtdfast.a, $RUST_TARGET)"
  else
    echo "tdfast didn't build: the helpers go without the native lane" >&2
  fi
else
  echo "no cargo: the helpers go without the native lane (Node's lane is used)" >&2
fi

# shellcheck disable=SC2086
swiftc -O -swift-version 5 -target "$TARGET" $TDFAST \
  -I Sources/VirtualDisplayBridge/include \
  -framework CoreGraphics -framework AppKit -framework ApplicationServices -framework IOKit -framework ScreenCaptureKit -framework CoreMedia -framework NetFS -framework CoreBluetooth -framework CoreWLAN -framework CoreLocation -lsqlite3 \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Sources/macshare-helper/Info.plist \
  Sources/macshare-helper/*.swift -o .build/release/macshare-helper
echo "built .build/release/macshare-helper"
# Multi-device's helper (docs/multi-device.md): the same sources with -D MULTI, several watched edges
# (the #if MULTI parts of Capture.swift and main.swift); only mac/mesh starts it.
# shellcheck disable=SC2086
swiftc -O -swift-version 5 -target "$TARGET" -D MULTI $TDFAST \
  -I Sources/VirtualDisplayBridge/include \
  -framework CoreGraphics -framework AppKit -framework ApplicationServices -framework IOKit -framework ScreenCaptureKit -framework CoreMedia -framework NetFS -framework CoreBluetooth -framework CoreWLAN -framework CoreLocation -lsqlite3 \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Sources/macshare-helper/Info.plist \
  Sources/macshare-helper/*.swift -o .build/release/macshare-helper-multi
echo "built .build/release/macshare-helper-multi"
swiftc -O -swift-version 5 -target "$TARGET" -framework AppKit \
  Sources/macshare-dockstub/main.swift -o .build/release/macshare-dockstub
echo "built .build/release/macshare-dockstub"
# An iPhone's or iPad's screen over its cable (mac/iosusb.js), its own process, run only while shown.
swiftc -O -swift-version 5 -target "$TARGET" -framework AVFoundation -framework CoreMediaIO -framework VideoToolbox -framework CoreMedia \
  Sources/macshare-iosusb/main.swift -o .build/release/macshare-iosusb
echo "built .build/release/macshare-iosusb"
# What plays on this Mac, any app, with its artwork (shared/web/pcmedia.js): a library run inside
# /usr/bin/perl, as macOS's MediaRemote answers only Apple's own processes.
clang -O2 -fobjc-arc -dynamiclib -target "$TARGET" -framework Foundation -framework AppKit -framework ImageIO \
  Sources/twindesk-nowplaying/nowplaying.m -o .build/release/libtwindesk-nowplaying.dylib
echo "built .build/release/libtwindesk-nowplaying.dylib"
# The calls' sound over Bluetooth (mac/callaudio.js), its own process: only it loads IOBluetooth.
swiftc -O -swift-version 5 -target "$TARGET" -framework IOBluetooth \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Sources/macshare-calls/Info.plist \
  Sources/macshare-calls/main.swift -o .build/release/macshare-calls
echo "built .build/release/macshare-calls"
# Camera › Virtual camera (mac/vcam.js): the Camera Extension and the tool that installs and feeds
# it (packed into TwinDesk.app by mac/build-app.sh when it's signed for system extensions).
swiftc -O -swift-version 5 -target "$TARGET" -framework CoreMediaIO -framework CoreMedia -framework CoreVideo -framework IOKit   Sources/twindesk-camera/main.swift -o .build/release/twindesk-camera
echo "built .build/release/twindesk-camera"
swiftc -O -swift-version 5 -target "$TARGET" -framework CoreMediaIO -framework CoreMedia -framework CoreVideo -framework SystemExtensions -framework VideoToolbox   Sources/twindesk-vcam/main.swift -o .build/release/twindesk-vcam
echo "built .build/release/twindesk-vcam"
# Share menu extension (packed into TwinDesk.app/Contents/PlugIns by mac/build-app.sh).
swiftc -O -swift-version 5 -target "$TARGET" -application-extension -parse-as-library \
  -module-name MacShareShare -framework AppKit -Xlinker -e -Xlinker _NSExtensionMain \
  Sources/macshare-share/ShareViewController.swift -o .build/release/macshare-share
echo "built .build/release/macshare-share"
