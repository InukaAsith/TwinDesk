#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds dist/TwinDesk.app (npm run dist [x64|arm64]). The app code keeps its dev layout inside
# Contents/Resources/app (mac/, shared/, mac-helper/.build/release/) so every `../` path still works;
# no asar, because mac-helper and scripts/*.sh are run straight from there.
set -e
unset ELECTRON_RUN_AS_NODE
cd "$(dirname "$0")"
ROOT=..
STAGE=dist/stage
ARCH=${1:-$(uname -m)}
case "$ARCH" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  x64|arm64) ;;
  *) echo "Error: unsupported macOS architecture '$ARCH' (use x64 or arm64)." >&2; exit 2 ;;
esac
EV=$(node -p "require('./node_modules/electron/package.json').version")

../mac-helper/build.sh "$ARCH"

# TwinDesk for Android with notification access, which the Mac installs on a phone over wireless
# debugging (phone-bridge.js): the newest full build from android/dist, if one was built.
FULL_APK=$(ls "$ROOT"/android/dist/*-full.apk 2>/dev/null | sort | tail -1)
if [ -n "$FULL_APK" ]; then cp "$FULL_APK" vendor/twindesk-android-full.apk; else echo "note: no android/dist/*-full.apk — the app won't offer the full Android build"; fi

# adb for wireless debugging (phone-bridge.js), fetched once into mac/vendor/adb (scripts/fetch-adb.sh).
sh scripts/fetch-adb.sh

rm -rf "$STAGE" && mkdir -p "$STAGE/mac" "$STAGE/shared" "$STAGE/mac-helper/.build/release" "$STAGE/node_modules"
rsync -a --exclude node_modules --exclude dist --exclude dev --exclude test --exclude dmg --exclude build-app.sh --exclude build-dmg.sh --exclude scripts/signing-identity.sh --exclude entitlements.plist ./ "$STAGE/mac/"
cp "$ROOT"/shared/*.js "$ROOT"/shared/*.css "$ROOT"/shared/*.html "$STAGE/shared/"
cp -R "$ROOT/shared/lang" "$STAGE/shared/"
# TwinDesk Web (shared/web/webwire.js): its server, the page (web/, without the Shortcuts sources) and
# the phone app's screen viewer and remote, which the page shows as they are.
mkdir -p "$STAGE/shared/web" "$STAGE/web" "$STAGE/android-web"
cp "$ROOT"/shared/web/*.js "$ROOT"/shared/web/*.html "$STAGE/shared/web/"
rsync -a --exclude shortcuts-src "$ROOT/web/" "$STAGE/web/"
cp -R "$ROOT/android/app/src/main/assets/web/." "$STAGE/android-web/"
cp "$ROOT"/mac-helper/.build/release/macshare-helper "$ROOT"/mac-helper/.build/release/macshare-helper-multi "$ROOT"/mac-helper/.build/release/macshare-dockstub "$ROOT"/mac-helper/.build/release/macshare-calls "$STAGE/mac-helper/.build/release/"
cp -R node_modules/ws "$STAGE/node_modules/"
mkdir -p "$STAGE/mac/node_modules" && cp -R node_modules/ws "$STAGE/mac/node_modules/"
cp "$ROOT/LICENSE" "$STAGE/"
cp "$ROOT/THIRD_PARTY_NOTICES" "$STAGE/"
node -e "
const p = require('./package.json');
require('fs').writeFileSync('$STAGE/package.json', JSON.stringify({
  name: p.name, productName: p.productName, version: p.version, description: p.description,
  license: p.license, main: 'mac/main.js', dependencies: p.dependencies,
}, null, 2));"

# App icon: the TwinDesk dark icon (shared/icon, drawn by make-icon.py).
cp "$ROOT/shared/icon/teindesk-dark.icns" dist/TwinDesk.icns

cat > dist/extra.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSLocalNetworkUsageDescription</key><string>TwinDesk finds and connects to your PC on the local network.</string>
  <key>NSMicrophoneUsageDescription</key><string>TwinDesk sends sound between your Mac and your PC.</string>
  <key>NSAudioCaptureUsageDescription</key><string>TwinDesk sends your Mac's sound to your PC.</string>
  <key>NSCameraUsageDescription</key><string>TwinDesk shows this Mac's camera on your other computer when you share it there.</string>
  <key>NSAppleEventsUsageDescription</key><string>TwinDesk asks Finder which folder is in front, to copy and paste files there.</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>TwinDesk connects to your phone and computers over Bluetooth when they aren't on your network.</string>
  <key>NSLocationUsageDescription</key><string>macOS shows Wi-Fi networks only to apps with Location. TwinDesk joins your phone's or PC's Wi-Fi to send files when they aren't on your network.</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>macOS shows Wi-Fi networks only to apps with Location. TwinDesk joins your phone's or PC's Wi-Fi to send files when they aren't on your network.</string>
  <key>NSLocationAlwaysAndWhenInUseUsageDescription</key><string>macOS shows Wi-Fi networks only to apps with Location. TwinDesk joins your phone's or PC's Wi-Fi to send files when they aren't on your network.</string>
  <key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>TwinDesk</string><key>CFBundleURLSchemes</key><array><string>macshare</string></array></dict></array>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string><string>ru</string><string>tr</string></array>
  <key>NSHumanReadableCopyright</key><string>Copyright (C) 2026 inukaasith. GPL-3.0.</string>
</dict></plist>
EOF

./node_modules/.bin/electron-packager "$STAGE" TwinDesk \
  --platform=darwin --arch="$ARCH" --electron-version="$EV" \
  --app-bundle-id=org.macshare.mac --app-version="$(node -p "require('./package.json').version")" \
  --icon=dist/TwinDesk.icns --extend-info=dist/extra.plist \
  --no-prune --asar=false --out=dist --overwrite --quiet

APP="dist/TwinDesk-darwin-$ARCH/TwinDesk.app"
cp -R locales/zh-Hans.lproj locales/ru.lproj locales/tr.lproj "$APP/Contents/Resources/"
rm -rf dist/TwinDesk.app && mv "$APP" dist/ && rm -rf "dist/TwinDesk-darwin-$ARCH" "$STAGE" dist/extra.plist
# The Share menu extension (mac-helper/Sources/macshare-share), sandboxed as macOS requires.
APPEX=dist/TwinDesk.app/Contents/PlugIns/MacShareShare.appex
VER="$(node -p "require('./package.json').version")"
mkdir -p "$APPEX/Contents/MacOS"
cp "$ROOT/mac-helper/.build/release/macshare-share" "$APPEX/Contents/MacOS/MacShareShare"
cat > "$APPEX/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>org.macshare.mac.share</string>
  <key>CFBundleName</key><string>TwinDesk</string>
  <key>CFBundleDisplayName</key><string>TwinDesk</string>
  <key>CFBundleExecutable</key><string>MacShareShare</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key><string>ShareViewController</string>
    <key>NSExtensionAttributes</key><dict>
      <key>NSExtensionActivationRule</key><dict>
        <key>NSExtensionActivationSupportsFileWithMaxCount</key><integer>1000</integer>
      </dict>
    </dict>
  </dict>
</dict></plist>
PLIST
cat > dist/share.entitlements <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.files.user-selected.read-only</key><true/>
</dict></plist>
PLIST

# Camera › Virtual camera (vcam.js): the Camera Extension and twindesk-vcam, which installs and feeds
# it, only in a build macOS takes it from: Developer ID (MAC_IDENTITY), the team (MAC_TEAM_ID, else
# APPLE_TEAM_ID) and two Developer ID provisioning profiles with the System Extension capability, the
# app's (MAC_APP_PROFILE, App ID org.macshare.mac) and the extension's (MAC_CAMERA_PROFILE, App ID
# org.macshare.mac.camera), both with the app group <team>.org.macshare.mac. Without them it isn't
# in the app, and the Camera tab says the virtual camera needs a release build.
# twindesk-vcam is in every build: it also feeds OBS Virtual Camera (OBS's own Camera Extension).
TEAM=${MAC_TEAM_ID:-$APPLE_TEAM_ID}
cp "$ROOT/mac-helper/.build/release/twindesk-vcam" dist/TwinDesk.app/Contents/MacOS/twindesk-vcam
SYSEXT=dist/TwinDesk.app/Contents/Library/SystemExtensions/org.macshare.mac.camera.systemextension
CAMERA=""
if [ -n "$MAC_IDENTITY" ] && [ -n "$TEAM" ] && [ -f "$MAC_APP_PROFILE" ] && [ -f "$MAC_CAMERA_PROFILE" ]; then
  CAMERA=1
  mkdir -p "$SYSEXT/Contents/MacOS"
  cp "$ROOT/mac-helper/.build/release/twindesk-camera" "$SYSEXT/Contents/MacOS/org.macshare.mac.camera"
  cp "$MAC_CAMERA_PROFILE" "$SYSEXT/Contents/embedded.provisionprofile"
  cp "$MAC_APP_PROFILE" dist/TwinDesk.app/Contents/embedded.provisionprofile
  cat > "$SYSEXT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>org.macshare.mac.camera</string>
  <key>CFBundleName</key><string>TwinDesk Camera</string>
  <key>CFBundleDisplayName</key><string>TwinDesk Camera</string>
  <key>CFBundleExecutable</key><string>org.macshare.mac.camera</string>
  <key>CFBundlePackageType</key><string>SYSX</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>CMIOExtension</key><dict>
    <key>CMIOExtensionMachServiceName</key><string>$TEAM.org.macshare.mac.camera</string>
  </dict>
  <key>NSSystemExtensionUsageDescription</key><string>TwinDesk Camera: the other computer's or the phone's camera, as a camera every app on this Mac can pick.</string>
</dict></plist>
PLIST
  cat > dist/camera.entitlements <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.application-groups</key><array><string>$TEAM.org.macshare.mac</string></array>
  <key>com.apple.application-identifier</key><string>$TEAM.org.macshare.mac.camera</string>
  <key>com.apple.developer.team-identifier</key><string>$TEAM</string>
</dict></plist>
PLIST
  # The app (and twindesk-vcam, signed as the app) may install system extensions.
  cp entitlements.plist dist/app.entitlements
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.system-extension.install bool true" \
    -c "Add :com.apple.security.application-groups array" -c "Add :com.apple.security.application-groups:0 string $TEAM.org.macshare.mac" \
    -c "Add :com.apple.application-identifier string $TEAM.org.macshare.mac" -c "Add :com.apple.developer.team-identifier string $TEAM" dist/app.entitlements
  echo "Camera extension: in the app"
else
  echo "note: no camera extension (Camera › Virtual camera): needs MAC_IDENTITY, MAC_TEAM_ID (or APPLE_TEAM_ID), MAC_APP_PROFILE and MAC_CAMERA_PROFILE"
fi

# Signing: with Developer ID (MAC_IDENTITY) for releases, with TwinDesk's self-signed certificate
# (scripts/signing-identity.sh) for local dev so permissions carry across updates, or ad-hoc.
ENTITLEMENTS="entitlements.plist"
OPTIONS=""

if [ -n "$MAC_IDENTITY" ]; then
  SIGN="--sign"
  ID="$MAC_IDENTITY"
  OPTIONS="--options runtime --timestamp"
  echo "Signing with Developer ID: $ID"
elif KC=$(scripts/signing-identity.sh 2>/dev/null) && SIGNTEST=$(mktemp) && cp /usr/bin/true "$SIGNTEST" \
  && { security list-keychains -d user | grep -qF "$KC" || eval "security list-keychains -d user -s \"$KC\" $(security list-keychains -d user | tr '\n' ' ')"; } \
  && codesign --force --keychain "$KC" --sign "TwinDesk Self-Signed" "$SIGNTEST" 2>/dev/null; then
  # codesign finds the certificate only in a keychain on the search list (a fresh CI machine's isn't):
  # it's added, and tried on a copy of true first; without it, ad-hoc below.
  rm -f "$SIGNTEST"
  SIGN="--keychain $KC --sign"
  ID="TwinDesk Self-Signed"
  OPTIONS=""
  echo "Signing with local self-signed certificate"
else
  rm -f "$SIGNTEST"
  echo "note: signing ad-hoc: permissions won't carry over to the next update"
  SIGN="--sign"
  ID="-"
  OPTIONS=""
fi
APP=dist/TwinDesk.app
if [ -n "$MAC_IDENTITY" ]; then
  # Hardened runtime (for notarization): every piece of code signed on its own, inside out, with
  # the entitlements: Electron's helper apps need JIT, and macOS gives the microphone, camera and
  # location only to code that has them (the helpers too). --deep would sign the nested code with
  # none. Each Mach-O file first (deepest first: adb, the helpers, Electron's libraries), then
  # the frameworks and helper apps as bundles, the share extension, the app.
  find "$APP/Contents" -type f ! -path "$APP/Contents/MacOS/*" ! -path "$APPEX/*" ! -path "$SYSEXT/*" | while IFS= read -r f; do
    file -b "$f" | grep -q 'Mach-O' && printf '%s\t%s\n' "$(printf '%s' "$f" | tr -cd / | wc -c)" "$f"
  done | sort -rn | cut -f2- | while IFS= read -r f; do
    codesign --force $OPTIONS $SIGN "$ID" --entitlements "$ENTITLEMENTS" "$f"
  done
  for b in "$APP"/Contents/Frameworks/*.framework "$APP"/Contents/Frameworks/*.app; do
    [ -e "$b" ] && codesign --force $OPTIONS $SIGN "$ID" --entitlements "$ENTITLEMENTS" "$b"
  done
  codesign --force $OPTIONS $SIGN "$ID" --entitlements dist/share.entitlements "$APPEX"
  if [ -n "$CAMERA" ]; then
    codesign --force $OPTIONS $SIGN "$ID" --entitlements dist/camera.entitlements "$SYSEXT"
    codesign --force $OPTIONS $SIGN "$ID" -i org.macshare.mac --entitlements dist/app.entitlements "$APP/Contents/MacOS/twindesk-vcam"
    ENTITLEMENTS=dist/app.entitlements
  else
    codesign --force $OPTIONS $SIGN "$ID" -i org.macshare.mac --entitlements "$ENTITLEMENTS" "$APP/Contents/MacOS/twindesk-vcam"
  fi
  codesign --force $OPTIONS $SIGN "$ID" --entitlements "$ENTITLEMENTS" "$APP"
else
  # One signature over the whole bundle (helpers first), so the edited Info.plist is sealed. With
  # TwinDesk's own certificate macOS keeps its permissions across updates; ad-hoc works, but each
  # update asks for them again.
  for b in "$APP"/Contents/Resources/app/mac-helper/.build/release/*; do [ -f "$b" ] && codesign --force $SIGN "$ID" "$b"; done
  codesign --force $SIGN "$ID" -i org.macshare.mac "$APP/Contents/MacOS/twindesk-vcam"
  codesign --force --deep $SIGN "$ID" "$APP"
  codesign --force $SIGN "$ID" --entitlements dist/share.entitlements "$APPEX" # --deep dropped its sandbox
  codesign --force $SIGN "$ID" "$APP"
fi
rm -f dist/share.entitlements dist/camera.entitlements dist/app.entitlements
codesign -dr - dist/TwinDesk.app 2>&1 | grep designated
echo "built mac/dist/TwinDesk.app"
