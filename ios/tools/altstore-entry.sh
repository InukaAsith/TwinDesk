#!/bin/bash
# Puts a release's IPA into altstore.json with the numbers AltStore/SideStore check against the
# downloaded file: version (CFBundleShortVersionString), buildVersion (CFBundleVersion, which CI
# sets to the run number) and size. A mismatch makes AltStore refuse the install ("does not match
# the build number specified by the source", #229).
#   bash ios/tools/altstore-entry.sh v3.1.1 "What's new, one line."
set -euo pipefail
TAG="${1:?usage: altstore-entry.sh <tag> [description]}"
DESC="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

gh release download "$TAG" -R InukaAsith/TwinDesk -p TwinDesk.ipa -D "$TMP"
unzip -q "$TMP/TwinDesk.ipa" 'Payload/*.app/Info.plist' -d "$TMP/x"
PLIST="$(ls "$TMP"/x/Payload/*.app/Info.plist)"
VER="$(plutil -extract CFBundleShortVersionString raw "$PLIST")"
BUILD="$(plutil -extract CFBundleVersion raw "$PLIST")"
MINOS="$(plutil -extract MinimumOSVersion raw "$PLIST")"
SIZE="$(stat -f%z "$TMP/TwinDesk.ipa")"

python3 -I - "$ROOT/altstore.json" "$TAG" "$VER" "$BUILD" "$MINOS" "$SIZE" "$DESC" <<'PY'
import json, sys, datetime
path, tag, ver, build, minos, size, desc = sys.argv[1:]
src = json.load(open(path))
app = src["apps"][0]
old = next((v for v in app["versions"] if v["version"] == ver), None)
entry = {
    "version": ver,
    "buildVersion": build,
    "date": (old or {}).get("date") or datetime.date.today().isoformat(),
    "localizedDescription": desc or (old or {}).get("localizedDescription", ""),
    "downloadURL": f"https://github.com/InukaAsith/TwinDesk/releases/download/{tag}/TwinDesk.ipa",
    "size": int(size),
    "minOSVersion": minos,
}
app["versions"] = [entry] + [v for v in app["versions"] if v["version"] != ver]
with open(path, "w") as f:
    json.dump(src, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"altstore.json: {ver} ({build}), {size} bytes, iOS {minos}+")
PY
