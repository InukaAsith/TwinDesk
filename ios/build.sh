#!/bin/bash
# TwinDesk for iOS: an unsigned IPA (dist/TwinDesk.ipa) that SideStore, AltStore or any signing tool
# signs with your Apple ID when it installs it. Needs Xcode (the Build iOS workflow has it) and
# XcodeGen (brew install xcodegen).
set -euo pipefail
cd "$(dirname "$0")"
xcodegen generate --quiet
rm -rf build dist
xcodebuild -project TwinDesk.xcodeproj -scheme TwinDesk -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  ${VERSION:+MARKETING_VERSION=$VERSION} ${BUILD_NUMBER:+CURRENT_PROJECT_VERSION=$BUILD_NUMBER} \
  build | (command -v xcbeautify >/dev/null && xcbeautify || cat)
APP=build/Build/Products/Release-iphoneos/TwinDesk.app
mkdir -p dist/Payload
cp -R "$APP" dist/Payload/
(cd dist && zip -qry TwinDesk.ipa Payload && rm -rf Payload)
ls -lh dist/TwinDesk.ipa
