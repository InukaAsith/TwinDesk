#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Share one folder with the paired PC over SMB. Run as root (TwinDesk starts it through
# the macOS administrator prompt). Usage: smb-share.sh <folder> <password-file>
# Creates a hidden, login-less account "macshare" with SMB (NT) password hashes, gives it
# read/write on the folder with an ACL, shares the folder as "TwinDesk" over SMB only (no guest),
# and turns the SMB server on. The password file is read and deleted.
# A step that fails (chmod +a on a privacy-protected folder such as ~/Documents, for one) undoes
# what this run added, and only that: an account or ACL entry that was already there stays (#34).
set -e
DIR="$1"; PWFILE="$2"; U=macshare; SHARE=MacShare
ACL="$U allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit"
PW=$(cat "$PWFILE"); rm -f "$PWFILE"
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }

ADDED_USER=; ADDED_ACL=; ADDED_SHARE=
undo() {
  st=$?
  [ "$st" -eq 0 ] && return
  [ -n "$ADDED_SHARE" ] && sharing -r "$SHARE" >/dev/null 2>&1
  [ -n "$ADDED_ACL" ] && chmod -a "$ACL" "$DIR" 2>/dev/null
  [ -n "$ADDED_USER" ] && sysadminctl -deleteUser "$U" >/dev/null 2>&1
  exit "$st"
}
trap undo EXIT

if ! id "$U" >/dev/null 2>&1; then
  sysadminctl -addUser "$U" -fullName "MacShare" -password "$PW" -home /var/empty -shell /usr/bin/false >/dev/null 2>&1
  ADDED_USER=1
fi
dscl . -create "/Users/$U" IsHidden 1
dscl . -create "/Users/$U" UserShell /usr/bin/false
pwpolicy -u "$U" -sethashtypes SMB-NT on >/dev/null 2>&1 || true
dscl . -passwd "/Users/$U" "$PW"                       # (re)set: stores the SMB-NT hash too
dseditgroup -o edit -a "$U" -t user com.apple.access_smb >/dev/null 2>&1 || true

# Sharing the same folder again: its entry is there already (a second one would pile up).
if ! ls -led "$DIR" 2>/dev/null | grep -q "user:$U allow"; then
  chmod +a "$ACL" "$DIR"
  ADDED_ACL=1
fi

sharing -r "$SHARE" >/dev/null 2>&1 || true
sharing -a "$DIR" -S "$SHARE" -s 001 -g 000 >/dev/null
ADDED_SHARE=1

launchctl enable system/com.apple.smbd
launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.smbd.plist 2>/dev/null || true
echo ok
