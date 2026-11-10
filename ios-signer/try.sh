#!/bin/sh
# A manual test of the signing helper from a terminal: see try.py.
set -e
cd "$(dirname "$0")"
cargo build -q
exec python3 try.py "$@"
