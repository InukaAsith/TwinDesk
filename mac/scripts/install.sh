#!/usr/bin/env bash
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Headless-safe macOS installer & updater.
# Can be run over SSH, Terminal, or via curl:
#   curl -fsSL https://raw.githubusercontent.com/InukaAsith/TwinDesk/main/mac/scripts/install.sh | bash
set -euo pipefail

REPO="InukaAsith/TwinDesk"
ARCH="$(uname -m)"

echo "==> Detecting architecture: ${ARCH}"
if [ "${ARCH}" = "arm64" ]; then
  ASSET_MATCH="TwinDesk-.*-arm64\.dmg"
else
  ASSET_MATCH="TwinDesk-.*-x64_Intel\.dmg"
fi

echo "==> Fetching latest TwinDesk release from GitHub..."
RELEASE_JSON="$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest")"
DOWNLOAD_URL="$(echo "${RELEASE_JSON}" | grep -o 'https://[^"]*' | grep -E "${ASSET_MATCH}" | head -n 1 || true)"

if [ -z "${DOWNLOAD_URL}" ]; then
  # Fallback to direct latest release pattern if rate-limited
  echo "GitHub API rate-limited or asset pattern not found, resolving download redirect..."
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/TwinDesk-$(echo "${ARCH}" | sed 's/x86_64/x64_Intel/').dmg"
fi

echo "==> Downloading: ${DOWNLOAD_URL}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
DMG_PATH="${TMP_DIR}/TwinDesk.dmg"
MOUNT_POINT="${TMP_DIR}/mount"

curl -fSL --progress-bar "${DOWNLOAD_URL}" -o "${DMG_PATH}"

# Check if TwinDesk is currently running
WAS_RUNNING=0
if pgrep -x "TwinDesk" >/dev/null 2>&1; then
  WAS_RUNNING=1
  echo "==> TwinDesk is currently running. Preparing seamless hot-swap..."
fi

echo "==> Mounting disk image..."
mkdir -p "${MOUNT_POINT}"
hdiutil attach "${DMG_PATH}" -mountpoint "${MOUNT_POINT}" -nobrowse -quiet

if [ ! -d "${MOUNT_POINT}/TwinDesk.app" ]; then
  echo "Error: TwinDesk.app not found inside DMG." >&2
  hdiutil detach "${MOUNT_POINT}" -quiet || true
  exit 1
fi

# Stop running instance right before replacement to minimize downtime
if [ "${WAS_RUNNING}" -eq 1 ]; then
  echo "==> Stopping running instance..."
  pkill -x "TwinDesk" 2>/dev/null || true
  sleep 1
fi

echo "==> Installing to /Applications/TwinDesk.app..."
rm -rf "/Applications/TwinDesk.app"
cp -R "${MOUNT_POINT}/TwinDesk.app" "/Applications/TwinDesk.app"

echo "==> Unmounting disk image..."
hdiutil detach "${MOUNT_POINT}" -quiet || true

# Strip quarantine attribute to completely eliminate Gatekeeper "Move to Bin" warning
echo "==> Removing macOS quarantine flags (Gatekeeper approval)..."
xattr -cr "/Applications/TwinDesk.app" 2>/dev/null || true

# Reopen immediately if it was running or if user requested
if [ "${WAS_RUNNING}" -eq 1 ] || [ "${1:-}" = "--launch" ]; then
  echo "==> Relaunching TwinDesk (remote mouse/keyboard control will reconnect)..."
  open -a "/Applications/TwinDesk.app"
fi

echo "==> TwinDesk successfully installed!"
