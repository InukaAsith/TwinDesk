#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds dist/TwinDesk.app (npm run dist). The app code keeps its dev layout inside
# Contents/Resources/app (mac/, shared/, mac-helper/.build/release/) so every `../` path still works;
# no asar, because mac-helper and scripts/*.sh are run straight from there.
set -e
unset ELECTRON_RUN_AS_NODE
cd "$(dirname "$0")"
ROOT=..
STAGE=dist/stage
ARCH=$(uname -m)
[ "$ARCH" = x86_64 ] && ARCH=x64
EV=$(node -p "require('./node_modules/electron/package.json').version")

../mac-helper/build.sh

# TwinDesk for Android with notification access, which the Mac installs on a phone over wireless
# debugging (phone-bridge.js): the newest full build from android/dist, if one was built.
FULL_APK=$(ls "$ROOT"/android/dist/*-full.apk 2>/dev/null | sort | tail -1)
if [ -n "$FULL_APK" ]; then cp "$FULL_APK" vendor/twindesk-android-full.apk; else echo "note: no android/dist/*-full.apk — the app won't offer the full Android build"; fi

# adb for wireless debugging (phone-bridge.js), fetched once into mac/vendor/adb (scripts/fetch-adb.sh).
sh scripts/fetch-adb.sh

rm -rf "$STAGE" && mkdir -p "$STAGE/mac" "$STAGE/shared" "$STAGE/mac-helper/.build/release" "$STAGE/node_modules"
rsync -a --exclude node_modules --exclude dist --exclude dev --exclude test --exclude dmg --exclude build-app.sh --exclude build-dmg.sh --exclude scripts/signing-identity.sh ./ "$STAGE/mac/"
cp "$ROOT"/shared/*.js "$ROOT"/shared/*.css "$ROOT"/shared/*.html "$STAGE/shared/"
# Which repository this build came from: the updater follows that project's releases (shared/updates.js).
printf '{"repo":"%s"}\n' "${GITHUB_REPOSITORY:-}" > "$STAGE/shared/update-source.json"
cp "$ROOT"/mac-helper/.build/release/macshare-helper "$ROOT"/mac-helper/.build/release/macshare-dockstub "$ROOT"/mac-helper/.build/release/macshare-calls "$STAGE/mac-helper/.build/release/"
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
  <key>NSCameraUsageDescription</key><string>TwinDesk does not use the camera.</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>TwinDesk connects to your phone and computers over Bluetooth when they aren't on your network.</string>
  <key>NSLocationUsageDescription</key><string>macOS shows Wi-Fi networks only to apps with Location. TwinDesk joins your phone's or PC's Wi-Fi to send files when they aren't on your network.</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>macOS shows Wi-Fi networks only to apps with Location. TwinDesk joins your phone's or PC's Wi-Fi to send files when they aren't on your network.</string>
  <key>NSLocationAlwaysAndWhenInUseUsageDescription</key><string>macOS shows Wi-Fi networks only to apps with Location. TwinDesk joins your phone's or PC's Wi-Fi to send files when they aren't on your network.</string>
  <key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>TwinDesk</string><key>CFBundleURLSchemes</key><array><string>macshare</string></array></dict></array>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHumanReadableCopyright</key><string>Copyright (C) 2026 inukaasith. GPL-3.0.</string>
</dict></plist>
EOF

./node_modules/.bin/electron-packager "$STAGE" TwinDesk \
  --platform=darwin --arch="$ARCH" --electron-version="$EV" \
  --app-bundle-id=org.macshare.mac --app-version="$(node -p "require('./package.json').version")" \
  --icon=dist/TwinDesk.icns --extend-info=dist/extra.plist \
  --no-prune --asar=false --out=dist --overwrite --quiet

APP="dist/TwinDesk-darwin-$ARCH/TwinDesk.app"
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

# One signature over the whole bundle (helpers first), so the edited Info.plist is sealed.
# The designated requirement is spelled out: "this bundle id", nothing about the build or the
# certificate. macOS keeps Screen Recording, Accessibility and Input Monitoring per app by that
# requirement, so every update (ad-hoc or not, from whichever machine or CI run built it) is the
# same app to it and the user's permissions carry over; the updater replaces the app in place.
if KC=$(scripts/signing-identity.sh); then SIGN="--keychain $KC --sign"; ID="TwinDesk Self-Signed"
else echo "note: signing ad-hoc (the requirement below still keeps permissions across updates)"; SIGN="--sign"; ID="-"; fi
req() { echo "=designated => identifier \"$1\""; }
sign_all() {
  # --deep first (Electron's own frameworks and helper apps), then each of ours with its own requirement.
  codesign --force --deep $SIGN "$ID" dist/TwinDesk.app || return 1
  for b in dist/TwinDesk.app/Contents/Resources/app/mac-helper/.build/release/*; do n=$(basename "$b"); codesign --force $SIGN "$ID" -i "$n" -r "$(req "$n")" "$b" || return 1; done
  codesign --force $SIGN "$ID" --entitlements dist/share.entitlements -r "$(req org.macshare.mac.share)" "$APPEX" || return 1 # --deep dropped its sandbox
  codesign --force $SIGN "$ID" -r "$(req org.macshare.mac)" dist/TwinDesk.app || return 1
}
# A certificate that can't sign (a runner's keychain, say) must not stop the build: sign ad-hoc.
if ! sign_all; then
  [ "$ID" != "-" ] || exit 1
  echo "note: signing with $ID failed, signing ad-hoc (the requirement still keeps permissions across updates)"
  SIGN="--sign"; ID="-"
  sign_all
fi
rm -f dist/share.entitlements
codesign -dr - dist/TwinDesk.app 2>&1 | grep designated
echo "built mac/dist/TwinDesk.app"
