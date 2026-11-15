#!/bin/sh
# Builds mac/vendor/twindesk-relay.jar (a dex in a jar, run with app_process) from Relay.java.
# Needs a JDK and the Android SDK (a platform's android.jar and build-tools' d8).
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
JAR=$(ls "$SDK"/platforms/android-*/android.jar | sort -V | head -1)
D8=$(command -v d8 || ls "$SDK"/build-tools/*/d8 | sort -V | tail -1)
OUT=$(mktemp -d)
javac --release 8 -nowarn -cp "$JAR" -d "$OUT/classes" Relay.java
(cd "$OUT/classes" && zip -qr ../classes.jar .)
"$D8" --release --min-api 21 --lib "$JAR" --output "$OUT" "$OUT/classes.jar"
(cd "$OUT" && rm -f relay.jar && zip -qX relay.jar classes.dex)
cp "$OUT/relay.jar" ../../mac/vendor/twindesk-relay.jar
rm -rf "$OUT"
echo "mac/vendor/twindesk-relay.jar"
