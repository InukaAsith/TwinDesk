#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Creates dist/TwinDesk.dmg from dist/TwinDesk.app (npm run dmg): the app and an Applications
# link over the hand-drawn background in dmg/ (dmg/make-background.sh renders it).
# The window layout is written by dmgbuild, installed once into dist/.dmgbuild (needs python3).
set -e
cd "$(dirname "$0")"

APP="dist/TwinDesk.app"
DMG_NAME=${1:-TwinDesk.dmg}
case "$DMG_NAME" in
  */*) DMG="$DMG_NAME" ;;
  *) DMG="dist/$DMG_NAME" ;;
esac
VOLNAME="TwinDesk"
VENV="dist/.dmgbuild"

if [ ! -d "$APP" ]; then
  echo "Error: $APP not found. Run ./build-app.sh first." >&2
  exit 1
fi

if [ ! -x "$VENV/bin/dmgbuild" ]; then
  echo "Installing dmgbuild into $VENV..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check dmgbuild
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

if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
  echo "Submitting $DMG to Apple Notary Service..."
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  echo "Stapling notarization ticket to $DMG..."
  xcrun stapler staple "$DMG"
  echo "Successfully notarized and stapled! Gatekeeper quarantine will not block this DMG."
elif [ -n "$APPLE_KEYCHAIN_PROFILE" ]; then
  echo "Submitting $DMG to Apple Notary Service using keychain profile '$APPLE_KEYCHAIN_PROFILE'..."
  xcrun notarytool submit "$DMG" \
    --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
    --wait
  echo "Stapling notarization ticket to $DMG..."
  xcrun stapler staple "$DMG"
  echo "Successfully notarized and stapled! Gatekeeper quarantine will not block this DMG."
fi
