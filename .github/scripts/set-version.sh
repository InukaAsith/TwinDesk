#!/usr/bin/env bash
# Sets the version in the checkout before a build (not committed): Android versionName and
# versionCode, and the version of the Windows, Mac and Linux apps. Usage: set-version.sh 2.2.0 20200
set -euo pipefail
version=$1
code=$2

sed -i -E "s/versionCode = [0-9]+/versionCode = $code/; s/versionName = \"[^\"]*\"/versionName = \"$version\"/" android/app/build.gradle.kts
for app in windows mac linux; do
  node -e "
    const fs = require('fs');
    const f = '$app/package.json';
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    p.version = '$version';
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');"
done
echo "Version $version (code $code)"
