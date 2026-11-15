#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Full KVM on Linux (docs/full-kvm.md): installs, changes or removes the system service. Run as root
# through pkexec by the Full KVM tab (fullkvm/manager.js); the person approves it once.
#
#   install.sh install <simple|system> <runtime> <app> [<config dir>]
#   install.sh mode <simple|system> [<config dir>]
#   install.sh remove
#
#   runtime     the Electron binary that runs service.js as Node (ELECTRON_RUN_AS_NODE=1), or the
#               AppImage (copied to /usr/local/lib/twindesk: the one in Downloads may move)
#   app         the folder with linux/fullkvm/service.js, or @APPDIR (inside the AppImage)
#   config dir  System-wide: the person's TwinDesk settings folder (~/.config/MacShare), whose
#               certificate, device id and pairings the machine node takes (the same device to
#               the others, at the same place on their map)
set -eu
umask 022

LIB=/usr/local/lib/twindesk
UNIT=/etc/systemd/system/twindesk-fullkvm.service
CONF_DIR=/etc/twindesk
MACHINE=/var/lib/twindesk
ACCOUNT=twindesk

die() { echo "fullkvm: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (pkexec)"

mode_ok() { case "$1" in simple|system) ;; *) die "mode is simple or system" ;; esac; }

write_conf() {
  mkdir -p "$CONF_DIR"
  printf '{"mode":"%s"}\n' "$1" > "$CONF_DIR/fullkvm.json"
  chmod 644 "$CONF_DIR/fullkvm.json"
}

account() {
  id "$ACCOUNT" >/dev/null 2>&1 || useradd --system --home-dir "$MACHINE" --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
  mkdir -p "$MACHINE"
  chown "$ACCOUNT:$ACCOUNT" "$MACHINE"
  chmod 700 "$MACHINE"
}

# The person's identity and pairings for the machine node: only from their own settings folder.
copy_state() {
  src=$1
  [ -n "$src" ] || die "System-wide needs the settings folder"
  src=$(readlink -f "$src")
  [ -d "$src" ] || die "no settings folder $src"
  if [ -n "${PKEXEC_UID:-}" ]; then
    [ "$(stat -c %u "$src")" = "$PKEXEC_UID" ] || die "the settings folder isn't yours"
  fi
  account
  for f in identity device.json paired.json paired-mesh.json pairing.json pairings.json multi.json settings.json; do
    rm -rf "${MACHINE:?}/$f"
    [ -e "$src/$f" ] && cp -a "$src/$f" "$MACHINE/$f"
  done
  chown -R "$ACCOUNT:$ACCOUNT" "$MACHINE"
  chmod -R go-rwx "$MACHINE"
}

wipe_state() {
  rm -rf "${MACHINE:?}"/* 2>/dev/null || true
}

reload_service() {
  systemctl kill -s HUP twindesk-fullkvm.service 2>/dev/null || systemctl restart twindesk-fullkvm.service
}

case "${1:-}" in
  install)
    mode=${2:-}; runtime=${3:-}; app=${4:-}; cfg=${5:-}
    mode_ok "$mode"
    [ -x "$runtime" ] || die "no runtime $runtime"
    mkdir -p "$LIB"
    extra=""
    case "$runtime" in
      *.AppImage|*.appimage)
        cp -f "$runtime" "$LIB/TwinDesk-FullKVM.AppImage"
        chmod 755 "$LIB/TwinDesk-FullKVM.AppImage"
        runtime="$LIB/TwinDesk-FullKVM.AppImage"
        extra="Environment=APPIMAGE_EXTRACT_AND_RUN=1"
        app=@APPDIR ;;
    esac
    if [ "$app" = @APPDIR ]; then
      root='process.env.APPDIR + "/resources/app"'
    else
      [ -f "$app/linux/fullkvm/service.js" ] || die "no service.js in $app"
      root=$(printf '%s' "$app" | sed 's/["\\]/\\&/g')
      root="\"$root\""
    fi
    cat > "$LIB/fullkvm-boot.js" <<EOF
// Written by install.sh: starts the Full KVM service from the TwinDesk app.
require(${root} + '/linux/fullkvm/service.js').main();
EOF
    write_conf "$mode"
    if [ "$mode" = system ]; then copy_state "$cfg"; fi
    cat > "$UNIT" <<EOF
[Unit]
Description=TwinDesk Full KVM: the mesh's mouse and keyboard on the lock and login screens
After=systemd-logind.service

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
$extra
ExecStart=$runtime $LIB/fullkvm-boot.js
Restart=always
RestartSec=2

[Install]
WantedBy=graphical.target
EOF
    systemctl daemon-reload
    systemctl enable twindesk-fullkvm.service >/dev/null 2>&1
    systemctl restart twindesk-fullkvm.service
    echo "installed ($mode)"
    ;;
  mode)
    mode=${2:-}; cfg=${3:-}
    mode_ok "$mode"
    [ -f "$UNIT" ] || die "not installed"
    write_conf "$mode"
    if [ "$mode" = system ]; then copy_state "$cfg"; else wipe_state; fi
    reload_service
    echo "mode $mode"
    ;;
  remove)
    systemctl disable --now twindesk-fullkvm.service >/dev/null 2>&1 || true
    rm -f "$UNIT" "$LIB/fullkvm-boot.js" "$LIB/TwinDesk-FullKVM.AppImage" "$CONF_DIR/fullkvm.json"
    rmdir "$LIB" "$CONF_DIR" 2>/dev/null || true
    systemctl daemon-reload
    rm -rf "${MACHINE:?}"
    id "$ACCOUNT" >/dev/null 2>&1 && userdel "$ACCOUNT" 2>/dev/null || true
    rm -rf /run/twindesk
    echo removed
    ;;
  *) die "install | mode | remove" ;;
esac
