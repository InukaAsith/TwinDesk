#!/usr/bin/env bash
# Works out the version this run builds and where it goes; writes to $GITHUB_OUTPUT:
#   version     2.2.0 (what the apps are built as: numbers only, installers need that)
#   code        Android versionCode (major*10000 + minor*100 + patch)
#   tag         the release tag, e.g. v2.2.0 or v2.1.1-pr9
#   prerelease  true for a pull request build
#   publish     true when this run puts the files on a release
#   sha         the commit the release points at
# Counts from the newest stable release: a merge to main is the next minor (2.1.0 -> 2.2.0, then
# 2.3.0 ...). Every pull request build is the next free patch of that minor as a pre-release
# (2.1.1, then 2.1.2 ...; tag v2.1.1-pr9), so no two builds share a version and the Android
# versionCode keeps rising. A pull request's older pre-releases go once its new one is up.
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, EVENT_NAME, PR_NUMBER, PR_HEAD_SHA, PR_FROM_FORK.
set -euo pipefail

base=$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" -q .tag_name 2>/dev/null || true)
# No release yet: gh prints the 404 body on stdout, so only a tag counts.
case "$base" in v[0-9]*) ;; *) base="" ;; esac
[ -n "$base" ] || base="v$(grep -m1 versionName android/app/build.gradle.kts | sed 's/.*"\(.*\)".*/\1/')"
# .github/version-floor: never count from below this (a phone that already runs a higher versionCode
# refuses an older APK). Delete the file once releases here are past it.
if [ -f .github/version-floor ]; then
  floor=$(tr -d "[:space:]" < .github/version-floor)
  [ "$(printf "%s
%s
" "${base#v}" "$floor" | sort -V | tail -1)" = "$floor" ] && base="v$floor"
fi
IFS=. read -r major minor patch <<< "${base#v}"
patch=${patch%%[!0-9]*}

sha=$GITHUB_SHA
publish=false
prerelease=false
tag=""

case "$EVENT_NAME" in
  push)
    # A re-run of a merge that already has its release keeps that version.
    existing=$(git tag --points-at "$GITHUB_SHA" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
    if [ -n "$existing" ]; then
      version=${existing#v}
    else
      version="$major.$((minor + 1)).0"
    fi
    tag="v$version"
    publish=true
    ;;
  pull_request)
    # The highest patch of this minor in any release: stable, pre-releases and drafts.
    taken=$(gh release list --repo "$GITHUB_REPOSITORY" --limit 200 --json tagName -q '.[].tagName' \
      | sed -nE "s/^v${major}\.${minor}\.([0-9]+)(-pr[0-9]+)?$/\1/p" | sort -n | tail -1 || true)
    taken=${taken:-0}
    next=$(( taken > patch ? taken : patch ))
    version="$major.$minor.$((next + 1))"
    [ $((next + 1)) -le 99 ] || { echo "::error::99 builds on $major.$minor already: release a new minor"; exit 1; }
    sha=$PR_HEAD_SHA
    prerelease=true
    tag="v$version-pr$PR_NUMBER"
    # A pull request from a fork can't write releases (read-only token): build only.
    [ "$PR_FROM_FORK" = "true" ] || publish=true
    # [no-release] in the head commit message: build (the compile check) but publish nothing.
    case "$(git log -1 --format=%B "$PR_HEAD_SHA" 2>/dev/null || true)" in *"[no-release]"*) publish=false ;; esac
    ;;
  *)
    version="$major.$minor.$((patch + 1))"
    ;;
esac

IFS=. read -r a b c <<< "$version"
{
  echo "version=$version"
  echo "code=$((a * 10000 + b * 100 + c))"
  echo "tag=$tag"
  echo "prerelease=$prerelease"
  echo "publish=$publish"
  echo "sha=$sha"
} | tee -a "$GITHUB_OUTPUT"
