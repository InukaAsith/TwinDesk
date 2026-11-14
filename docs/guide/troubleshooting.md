# Troubleshooting

Start with two things: update **every** device you pair to the same version, and look at
**General › Advanced › Engines in use**, which says what this session runs on and why a faster path
isn't in use. For a bug report, attach the log: **Open log folder** in the tray or menu bar menu.

## Devices don't find each other

- **Same network?** Discovery is UDP **47801** and the session is TCP **47800**. Guest Wi-Fi, office
  Wi-Fi and some routers ("AP isolation", "client isolation") block devices from seeing each other.
  Bluetooth, a phone's hotspot or a USB cable still work, and so does **Connect by address**
  (Connection) with the other computer's IP.
- **Windows firewall.** Allow TwinDesk when Windows asks. If you missed it, Setup's firewall check
  fixes it. Windows marks most new Wi-Fi networks as Public, and TwinDesk's rule covers every profile.
- **Linux firewall.** Setup's firewall fix opens TwinDesk's ports and mDNS (5353/udp). With
  firewalld blocking inbound UDP, discovery and the fast input lane can't get in.
- **"Port 47800 is in use".** Another program holds the port. On Windows with **WSL2**, a program
  inside WSL can hold it without showing in Windows' `netstat`: run
  `wsl -e sh -c 'ss -lntup | grep 478'`, or `wsl --shutdown`. TwinDesk tries the port again every
  10 seconds (#124).
- **Away from home.** Put both devices on the same Tailscale tailnet. TwinDesk reaches a paired
  computer through it when discovery can't see it (#161).
- **"looks different now".** The other device was reinstalled or reset, so its certificate changed.
  Forget it (Connection › Forget) and pair again.

## Pairing fails

- **Locked out.** Five failed or cancelled pairings from one address within 10 minutes lock it out
  for the rest of the window. Wait, then try again.
- **Version mismatch.** Update the side that's older. The message says which.
- **One UI (Samsung), wireless debugging.** The pairing code changes when you leave the dialog. Type
  it while the dialog is still open (#32).

## Mouse and keyboard

- **Mac: nothing moves.** Grant **Accessibility** and **Input Monitoring** in System Settings ›
  Privacy & Security, then quit and reopen TwinDesk. After an update that reset them, the Setup
  screen shows which ones are missing.
- **Linux on Wayland: nothing moves.** Run Setup's **Fix** for input access, then log out and in.
  General › Input access shows the state. On distros with glibc older than 2.32, update to 2.5.3 or
  later (#149).
- **The pointer comes back by itself.** **Shake to bring the pointer back** may be catching fast moves. Turn it off on
  the Cursor page (#155, #160).
- **Quick flicks cross to the other computer.** Turn on **Edge resistance** on the Cursor page.
- **The pointer crosses at the wrong place.** Arrange the monitors on the Cursor page's map (in
  Multi-device, on the Multi-device page) to match your desk.
- **Stuck on the other computer.** Double-tap **Right Alt** (Right Option on a Mac), the hotkey, to
  bring everything home.
- **Wrong keys or symbols.** Each side types in its own keyboard layout. If a layout still comes out
  wrong, open an issue with both layouts named (#10, #188).
- **Windows: a UAC prompt or the lock screen.** Windows keeps these on a secure desktop that no
  normal app can reach. Use the computer's own mouse for that prompt (#210).

## Screens

- **Black screen, "Waiting for the picture".** On Windows, turn off the **hardware encoder** (Share
  screen › Picture) and try again (#133). Codec **H.264** works everywhere, H.265 needs both sides
  to support it.
- **Extend isn't offered.** Windows needs the virtual display driver (Share screen installs it).
  Windows on ARM can't load it (#14). On Linux, GNOME on Wayland uses Mutter's virtual monitor, KDE
  Plasma on Wayland uses krfb-virtualmonitor, and X11 needs a spare output (not on NVIDIA's driver).
- **Linux: the screen picker keeps opening.** Pick the screen, or "Virtual remote monitor" for
  Extend, and press Share.
- **The share stopped after locking the computer.** It comes back on unlock. Update if it doesn't.

## Files and clipboard

- **Slow files.** Engines in use should say **fx2**. Over Bluetooth, TwinDesk moves big transfers to
  Wi-Fi Direct by itself. For the most speed on a network you trust, turn off **Files › Encrypt file
  transfers** on both sides.
- **Linux on Wayland: the clipboard doesn't sync.** TwinDesk uses `wl-clipboard`. Install it
  (`wl-copy`, `wl-paste`) if your distro doesn't have it.
- **Mac: pasting waits a moment.** That's Universal Clipboard fetching from another Apple device. It
  no longer delays TwinDesk (#211).
- **Passwords don't sync.** On purpose: entries a password manager marks as private are skipped.

## Android phone

- **Play Protect blocks the APK.** Tap **More details › Install anyway**. Where there's no such
  button, pause **Scan apps with Play Protect** in the Play Store while you install, then turn it
  back on, or let the computer install it over wireless debugging.
- **Notification access or Accessibility greyed out.** Settings › Apps › TwinDesk › ⋮ › **Allow
  restricted settings**.
- **The screen shows but taps do nothing (Xiaomi, Redmi, POCO).** Turn on **Developer options › USB
  debugging (Security settings)**.
- **Wireless debugging keeps turning off** (MIUI, HyperOS). TwinDesk turns it back on when the phone
  is unlocked. Keep TwinDesk allowed to run in the background (General on the phone).
- **The phone doesn't reconnect after Wi-Fi was gone a while.** Update both sides to 3.1 (#192).
- **Gesture navigation stopped working.** Update to 2.4 or later (#67, #118).

## Antivirus warnings

Unsigned installers, input hooks and a virtual camera look like malware to some heuristics.
TwinDesk is built in the open by GitHub Actions from this repository. A detection on
`TwinDesk-Setup-*.exe` or `twindesk-vcam-*.dll` is a false positive (#12, #111). Allow it, or build
it yourself from source.

## Still stuck

[Open an issue](https://github.com/InukaAsith/TwinDesk/issues/new/choose) with the versions and
platforms of both devices, what you did, what happened, and the log from Open log folder.
