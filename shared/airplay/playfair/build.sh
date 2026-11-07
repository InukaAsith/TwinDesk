#!/bin/sh
# TwinDesk — GPL-3.0. Builds playfair.wasm (FairPlay's key unwrap for the AirPlay receiver,
# shared/airplay/fairplay.js) from the playfair sources here (UxPlay lib/playfair, unchanged).
# Needs a clang with the WebAssembly target (Homebrew llvm) and a wasm linker (rust-lld from any
# Rust toolchain, or wasm-ld). The .wasm is committed: building the app doesn't need this.
set -e
cd "$(dirname "$0")"
CC=${CC:-$(command -v /opt/homebrew/opt/llvm/bin/clang || command -v clang)}
LD=${LD:-$(command -v wasm-ld || ls ~/.rustup/toolchains/*/lib/rustlib/*/bin/rust-lld 2>/dev/null | head -1)}
OUT=$(mktemp -d)
for f in hand_garble.c modified_md5.c omg_hax.c playfair.c sap_hash.c shim/shim.c; do
  "$CC" --target=wasm32 -O2 -ffreestanding -nostdlib -fno-builtin -Ishim -I. -w -c "$f" -o "$OUT/$(basename "$f" .c).o"
done
case "$LD" in *rust-lld) FL="-flavor wasm" ;; *) FL="" ;; esac
"$LD" $FL --no-entry --strip-all --export=td_io --export=td_decrypt -o ../playfair.wasm "$OUT"/*.o
rm -rf "$OUT"
ls -l ../playfair.wasm
