#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds the iOS signing helper for the apps: bin/<x64|arm64>/twindesk-ios-signer (shared/iossign-host.js
# looks there). `build.sh [x64|arm64]`, this machine's architecture when left out. Optional: an app
# without it leaves iPhone app signing out. TWINDESK_SIGNER_ANY_IPA=1 builds the one that also installs
# an IPA the person picks (the Mac and Linux apps; the Windows installer leaves it off, see build.cmd).
set -e
cd "$(dirname "$0")"
command -v cargo >/dev/null 2>&1 || { echo "note: no cargo: no iOS signing helper" >&2; exit 0; }
ARCH=${1:-$(uname -m)}
case "$ARCH" in x86_64|amd64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; esac
case "$(uname -s)-$ARCH" in
  Darwin-x64) T=x86_64-apple-darwin ;;
  Darwin-arm64) T=aarch64-apple-darwin ;;
  Linux-x64) T=x86_64-unknown-linux-gnu ;;
  Linux-arm64) T=aarch64-unknown-linux-gnu ;;
  *) echo "note: no iOS signing helper for $(uname -s) $ARCH" >&2; exit 0 ;;
esac
FEATURES=""
[ -n "$TWINDESK_SIGNER_ANY_IPA" ] && FEATURES="--features any-ipa"
cargo build --release --locked $FEATURES --target "$T"
mkdir -p "bin/$ARCH"
cp "target/$T/release/twindesk-ios-signer" "bin/$ARCH/twindesk-ios-signer"
echo "ios-signer: bin/$ARCH/twindesk-ios-signer${FEATURES:+ (any IPA)}"
