#!/usr/bin/env bash
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Enables TwinDesk at Linux Login Screen (Display Managers: GDM, SDDM, LightDM).
# Configures uinput permissions and installs the systemd background helper.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (e.g. sudo $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Ensure uinput module is loaded
if ! lsmod | grep -q uinput; then
  echo "Loading uinput kernel module..."
  modprobe uinput || true
  if [[ -d /etc/modules-load.d ]]; then
    echo "uinput" > /etc/modules-load.d/uinput.conf
  fi
fi

# Configure udev rules for uinput access
UDEV_RULE="/etc/udev/rules.d/99-twindesk-uinput.rules"
echo "Installing uinput udev rules to ${UDEV_RULE}..."
cat << 'EOF' > "${UDEV_RULE}"
KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"
EOF
udevadm control --reload-rules || true
udevadm trigger /dev/uinput || true

# Find helper binary
HELPER_BIN=""
if [[ -f "/usr/local/bin/macshare-linuxhelper" ]]; then
  HELPER_BIN="/usr/local/bin/macshare-linuxhelper"
elif [[ -f "${ROOT_DIR}/linux-helper/bin/macshare-linuxhelper" ]]; then
  HELPER_BIN="${ROOT_DIR}/linux-helper/bin/macshare-linuxhelper"
  echo "Copying ${HELPER_BIN} to /usr/local/bin/macshare-linuxhelper..."
  install -m 755 "${HELPER_BIN}" /usr/local/bin/macshare-linuxhelper
fi

# Install systemd service
SERVICE_SRC="${SCRIPT_DIR}/../systemd/twindesk-login.service"
SERVICE_DEST="/etc/systemd/system/twindesk-login.service"

if [[ -f "${SERVICE_SRC}" ]]; then
  echo "Installing systemd service to ${SERVICE_DEST}..."
  cp "${SERVICE_SRC}" "${SERVICE_DEST}"
  systemctl daemon-reload
  systemctl enable twindesk-login.service
  systemctl restart twindesk-login.service || true
  echo "TwinDesk login service enabled and started successfully."
else
  echo "Warning: Could not find ${SERVICE_SRC}."
fi
