#!/bin/sh
# The sealed conversation between the iPhone's code and the helper (see main.swift). On a Mac.
set -e
cd "$(dirname "$0")/.."
cargo build -q
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
swiftc -O ../ios/TwinDesk/Core/Signer.swift test/main.swift -o "$OUT/sealtest"
"$OUT/sealtest" target/debug/twindesk-ios-signer
