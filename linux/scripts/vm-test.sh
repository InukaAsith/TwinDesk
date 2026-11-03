#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Test the Linux app from a Mac, in a Parallels Desktop Linux VM: copies this checkout into the VM,
# builds the helper, runs the app in the VM's desktop session with Chrome DevTools on a port, and
# drives it from here (screenshots, eval, clicks through scripts/cdp.js).
#
#   linux/scripts/vm-test.sh sync           copy the checkout to ~/twindesk in the VM, npm install, build the helper
#   linux/scripts/vm-test.sh start          (re)start TwinDesk in the VM's desktop session (sync first if needed)
#   linux/scripts/vm-test.sh stop
#   linux/scripts/vm-test.sh log            the app's output
#   linux/scripts/vm-test.sh shot out.png   screenshot of TwinDesk's window (DevTools); `screen out.png`: the whole VM
#   linux/scripts/vm-test.sh eval 'expr'    run JavaScript in the window (e.g. UI.go('overview'))
#   linux/scripts/vm-test.sh click x,y
#   linux/scripts/vm-test.sh sh 'cmd'       a shell command in the VM, as the desktop user
#   linux/scripts/vm-test.sh dist           build the AppImage and .deb in the VM, copied back to linux/dist/
#
# Settings (environment): TWINDESK_VM (VM name, default the first running Linux VM), TWINDESK_VM_USER
# (default: the user with the desktop session). The VM needs Parallels Tools (it shares the Mac's
# home at /media/psf/Home), node 18+, and the packages from the README's Linux section. It runs on
# the VM's X11 or Wayland session as is; with the VM on the same network (Parallels "Bridged"),
# it pairs with this Mac's TwinDesk like any Linux computer.
set -e
cd "$(dirname "$0")/../.."
REPO=$(pwd)
PORT=9333
VM=${TWINDESK_VM:-$(prlctl list -o status,name --no-header | awk '$1=="running"{ $1=""; sub(/^ /,""); print; exit }')}
[ -n "$VM" ] || { echo "No running VM (start it in Parallels, or set TWINDESK_VM)" >&2; exit 1; }
case "$REPO" in "$HOME"/*) SHARED="/media/psf/Home/${REPO#"$HOME"/}" ;; *) echo "The checkout must be under $HOME (shared as /media/psf/Home)" >&2; exit 1 ;; esac

root() { prlctl exec "$VM" "$1"; }
# The desktop user and its session's environment (DISPLAY, Wayland, D-Bus), from gnome-shell or
# whichever session process is running.
USR=${TWINDESK_VM_USER:-$(root "loginctl list-sessions --no-legend | awk '\$4==\"seat0\"{print \$3; exit}'")}
[ -n "$USR" ] || { echo "Nobody is logged in to the VM's desktop" >&2; exit 1; }
as() {
  root "echo $(printf '%s' "$1" | base64 | tr -d '\n') | base64 -d | sudo -u $USR -H bash -l"
}
ENV='pid=$(pgrep -u $(id -u) -n "gnome-shell|plasmashell|xfce4-session|cinnamon|mate-session" || pgrep -u $(id -u) -n gnome-session); export $(tr "\0" "\n" < /proc/$pid/environ | grep -E "^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP)=" | xargs)'

case "$1" in
  sync)
    as "mkdir -p ~/twindesk && rsync -a --delete --exclude .git --exclude node_modules --exclude 'dist/' --exclude 'android/build' --exclude 'android/app/build' --exclude 'android/.gradle' --exclude 'mac-helper/.build' --exclude 'windows/vendor/adb' --exclude 'linux-helper/bin' --exclude 'linux-helper/lib' --exclude 'native/tdfast/target' --exclude 'mac-helper/lib' --exclude 'linux/vendor/adb' '$SHARED/' ~/twindesk/"
    as "cd ~/twindesk/linux && { [ -d node_modules/electron/dist ] || npm install --no-audit --no-fund; } && sh ../linux-helper/build.sh"
    ;;
  start)
    as "[ -d ~/twindesk/linux/node_modules/electron/dist ]" || "$0" sync
    "$0" stop
    # A unit of the user's systemd, like an app started from the desktop: polkit counts it as the
    # person at the computer (pkexec with no password where an action allows that, vdd.js).
    as "$ENV; systemd-run --user --quiet --collect --unit=twindesk-vm-test -p StandardOutput=truncate:/tmp/twindesk-linux.log \
      -E DISPLAY -E WAYLAND_DISPLAY -E XAUTHORITY -E XDG_SESSION_TYPE -E XDG_CURRENT_DESKTOP \
      \$HOME/twindesk/linux/node_modules/.bin/electron \$HOME/twindesk/linux --remote-debugging-port=$PORT"
    sleep 6
    as "tail -5 /tmp/twindesk-linux.log"
    ;;
  stop)
    as "$ENV; systemctl --user stop twindesk-vm-test 2>/dev/null; pkill -u \$(id -u) -f '[t]windesk/linux/node_modules/electron/dist/electron' || true; pkill -u \$(id -u) -f '[m]acshare-linuxhelper' || true"
    ;;
  log) as "cat /tmp/twindesk-linux.log" ;;
  shot)
    out=${2:-twindesk-linux.png}
    as "cd ~/twindesk/linux && node ../linux/scripts/cdp.js $PORT shot /tmp/twindesk-shot.png ${3:-app.html}"
    as "cat /tmp/twindesk-shot.png" > "$out"
    echo "$out"
    ;;
  screen)
    out=${2:-twindesk-vm.png}
    prlctl capture "$VM" --file "$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
    echo "$out"
    ;;
  eval)
    b64=$(printf '%s' "$2" | base64 | tr -d '\n')
    as "cd ~/twindesk/linux && node ../linux/scripts/cdp.js $PORT eval \"\$(echo $b64 | base64 -d)\" ${3:-app.html}"
    ;;
  click) as "cd ~/twindesk/linux && node ../linux/scripts/cdp.js $PORT click $2 ${3:-app.html}" ;;
  sh) as "$ENV; $2" ;;
  dist)
    "$0" sync
    as "cd ~/twindesk/linux && npm run dist"
    mkdir -p linux/dist
    for f in $(as "cd ~/twindesk/linux/dist && ls *.AppImage *.deb 2>/dev/null"); do as "cat ~/twindesk/linux/dist/$f" > "linux/dist/$f"; echo "linux/dist/$f"; done
    ;;
  *) sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
