#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# The Windows installer, built on Linux with Docker (windows/docker/Dockerfile, inside.sh).
#   windows/docker/build.sh [full-kvm] [x64] [arm64] [portable]
# full-kvm: the Full KVM build (TWINDESK_EDITION=full-kvm). The installers land in windows/dist/, as
# `npm run dist` puts them on Windows. The image is built once (a few GB of downloads); its caches
# (Electron, NSIS, Microsoft's CRT for cargo-xwin, Cargo's registry) are kept in a Docker volume.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=twindesk-winbuild
EDITION=${TWINDESK_EDITION:-}
ARGS=""
for a in "$@"; do
  if [ "$a" = "full-kvm" ]; then EDITION=full-kvm; else ARGS="$ARGS $a"; fi
done

docker build -t "$IMAGE" "$ROOT/windows/docker"
# -t only with a terminal: the build's progress then shows as it goes.
TTY=""
[ -t 1 ] && TTY="-t"
# shellcheck disable=SC2086
exec docker run --rm $TTY \
  -v "$ROOT":/src \
  -v twindesk-winbuild-cache:/root/.cache \
  -v twindesk-winbuild-cargo:/root/.cargo/registry \
  -e TWINDESK_EDITION="$EDITION" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$IMAGE" bash /src/windows/docker/inside.sh $ARGS
