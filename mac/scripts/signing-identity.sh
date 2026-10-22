#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# The certificate build-app.sh signs TwinDesk.app with. macOS keeps Screen Recording, Accessibility
# and Input Monitoring per app by its signature's designated requirement: ad-hoc, that is the
# build's hash, so every update looked like a new app (the switches stayed on in System Settings
# but did nothing). Signed with one certificate, it's "this bundle id, this certificate", the same
# for every build, and permissions carry over updates.
#
# Made once per build machine in its own keychain (~/.twindesk-signing), never committed: anyone
# with the private key could sign an app macOS treats as TwinDesk. Keep a backup of that folder;
# a new certificate means people allow everything once more after that update.
# Prints the keychain path; build-app.sh signs with: codesign --keychain <it> --sign "TwinDesk Self-Signed".
set -e
NAME="TwinDesk Self-Signed"
DIR="$HOME/.twindesk-signing"
KC="$DIR/signing.keychain-db"
PW=twindesk # the keychain only holds this certificate; the file's permissions guard it

if [ ! -f "$KC" ]; then
  mkdir -p "$DIR" && chmod 700 "$DIR"
  T=$(mktemp -d)
  cat > "$T/cs.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$NAME
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/key.pem" -out "$T/cert.pem" -days 7300 -config "$T/cs.cnf" >/dev/null 2>&1
  openssl pkcs12 -export -legacy -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/id.p12" -passout pass:$PW 2>/dev/null \
    || openssl pkcs12 -export -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/id.p12" -passout pass:$PW
  security create-keychain -p $PW "$KC"
  security set-keychain-settings "$KC" # no auto-lock
  security unlock-keychain -p $PW "$KC"
  security import "$T/id.p12" -k "$KC" -P $PW -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $PW "$KC" >/dev/null
  cp "$T/cert.pem" "$DIR/cert.pem"
  rm -rf "$T"
fi
security unlock-keychain -p $PW "$KC"
security find-identity -p codesigning "$KC" | grep -q "\"$NAME\"" || { echo "no \"$NAME\" in $KC" >&2; exit 1; }
echo "$KC"
