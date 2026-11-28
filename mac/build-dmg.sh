#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Creates dist/TwinDesk-<version>-<arch>.dmg from dist/TwinDesk.app (npm run dmg), named after
# the app inside it like the other platforms' downloads: TwinDesk-2.3.0-arm64.dmg (Apple silicon)
# or TwinDesk-2.3.0-x64.dmg (Intel), the words the updater tells them apart by (shared/updates.js
# pickAsset, the same since 2.0.0). A name as the argument instead: ./build-dmg.sh Other.dmg.
# Its volume is "TwinDesk <version>", so an older one still mounted isn't the one that opens.
# The app and an Applications link over the hand-drawn background in dmg/ (dmg/make-background.sh
# renders it); the window layout is written by dmgbuild, installed once into dist/.dmgbuild (needs python3).
set -e
cd "$(dirname "$0")"

APP="dist/TwinDesk.app"
if [ ! -d "$APP" ]; then
  echo "Error: $APP not found. Run ./build-app.sh first." >&2
  exit 1
fi

# The version and architecture of the app that was built (build-app.sh x64 / arm64).
VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null \
  || node -p "require('./package.json').version")"
ARCH="$(lipo -archs "$APP/Contents/MacOS/TwinDesk")"
case "$ARCH" in
  x86_64) ARCH=x64 ;;
  arm64) ;;
  *) echo "Error: $APP is '$ARCH', not one architecture (build-app.sh x64 or arm64)." >&2; exit 2 ;;
esac
DMG_NAME=${1:-TwinDesk-$VER-$ARCH.dmg}
case "$DMG_NAME" in
  */*) DMG="$DMG_NAME" ;;
  *) DMG="dist/$DMG_NAME" ;;
esac
VOLNAME="TwinDesk $VER"
VENV="dist/.dmgbuild"

if [ ! -x "$VENV/bin/dmgbuild" ]; then
  echo "Installing dmgbuild into $VENV..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check dmgbuild
fi

# Notarization: the app first, its ticket stapled to it before it goes into the image (#75), so a copy
# dragged out of the DMG opens offline too (Gatekeeper checks the app, not the image it came from);
# then the DMG itself, below. Only with a notary account.
notarize() { # <file to submit>
  if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
    xcrun notarytool submit "$1" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  elif [ -n "$APPLE_KEYCHAIN_PROFILE" ]; then
    xcrun notarytool submit "$1" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
  else
    return 1
  fi
}
NOTARY=""
if { [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; } || [ -n "$APPLE_KEYCHAIN_PROFILE" ]; then
  NOTARY=1
  ZIP="dist/.notarize-app.zip"
  echo "Submitting $APP to Apple Notary Service..."
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  notarize "$ZIP"
  rm -f "$ZIP"
  echo "Stapling notarization ticket to $APP..."
  xcrun stapler staple "$APP"
fi

echo "Creating disk image $DMG..."
rm -f "$DMG"
"$VENV/bin/dmgbuild" -s dmg/settings.py \
  -D app="$APP" -D icon=dist/TwinDesk.icns -D background=dmg/background.tiff \
  "$VOLNAME" "$DMG"

echo "DMG created successfully: $DMG"
ls -lh "$DMG"

# Developer ID signing & Apple Notarization (optional, avoids Gatekeeper quarantine)
if [ -n "$MAC_IDENTITY" ]; then
  echo "Signing $DMG with Developer ID: $MAC_IDENTITY..."
  codesign --force --sign "$MAC_IDENTITY" --timestamp "$DMG"
fi

if [ -n "$NOTARY" ]; then
  echo "Submitting $DMG to Apple Notary Service..."
  notarize "$DMG"
  echo "Stapling notarization ticket to $DMG..."
  xcrun stapler staple "$DMG"
  echo "Successfully notarized and stapled, the app inside too: Gatekeeper quarantine will not block them."
fi
