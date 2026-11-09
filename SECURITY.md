# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue:
**[Report a vulnerability](https://github.com/InukaAsith/TwinDesk/security/advisories/new)**
(the repository's Security tab › Report a vulnerability).

Include what you can of:

- the TwinDesk version and platforms (Mac, Windows, Linux, Android, iPhone or iPad);
- what an attacker needs (the same network, Bluetooth range, a paired device, a local account);
- steps to reproduce, or a proof of concept;
- what it gives them (reading the screen or files, injecting input, running code, a crash).

You'll get an answer within a few days. Fixes go out in the next release, or sooner for anything
that lets an unpaired device in. Once a fix has shipped, the advisory is published and credits you
unless you'd rather not be named.

## Supported versions

| Version | Fixes |
|---|---|
| Latest release (3.0.x) | Yes |
| Older | No: update to the latest release |

Each app checks for updates itself. The Homebrew cask and the Android app follow the releases.

## How TwinDesk protects a session

- **Pairing.** Two devices pair once, and the person at each one confirms it. Both show a 6-digit
  code derived from the host's certificate fingerprint and a nonce from each side. The guest commits
  to its nonce before seeing the host's, so neither side can pick a code. Five failed or cancelled
  pairings from one address within 10 minutes lock that address out for the rest of the window.
- **Every session is TLS** (WSS on TCP 47800), pinned to the paired device's certificate, on the
  network, through a phone's USB cable or through Bluetooth LE. The token each device presents is
  checked in constant time against a stored hash.
- **Input lane (tdv2).** Mouse and keyboard over UDP use AES-256-GCM with a random key made for each
  session and sent inside the TLS session (one key per direction, HKDF-SHA256), and a 64-packet
  replay window.
- **Files.** File transfers are encrypted by default (Files › Encrypt file transfers). Turned off,
  file bytes travel unencrypted on the local network for speed, still with a per-session token.
- **Nothing in the cloud.** Devices talk to each other directly (the local network, Wi-Fi Direct,
  Bluetooth, a USB cable, or Tailscale if you use it). There are no TwinDesk accounts or servers.
- **Exposure before pairing.** An unpaired device can only start a pairing, which the person at the
  other device has to allow. Sockets that haven't authenticated close after 70 seconds, at most 16
  per address are kept.

## Known limitations

- **Pairing tokens are stored as files** in the app's data folder, protected by the operating
  system's file permissions, not by its keychain. Anyone who can read your user account's files can
  copy them.
- **Windows firewall rules cover every network profile.** Windows marks most new Wi-Fi networks as
  Public, and TwinDesk has to work there. Pairing still requires the person at the computer to
  allow it.
- **Discovery** broadcasts each device's name, ID, kind, port and certificate fingerprint on the
  local network (UDP 47801), and Bluetooth LE advertising shows its name while TwinDesk is looking
  for devices. None of these lets a device in without pairing.
- **Tailscale.** TwinDesk follows your tailnet's access rules. Anyone your tailnet lets reach the
  computer can try to pair with it, as on a local network.
- **Remote control is the point of the app.** A paired device can see the screen and send input
  wherever you have turned those features on. Forget a device you no longer trust (Connection ›
  Forget) and its token stops working at once.

## Out of scope

- Attacks that need the device unlocked and in hand, or administrator or root access.
- A paired device using the features you turned on for it.
- Antivirus false positives on the installers (see #12).
- Bugs in the operating system, Electron, scrcpy or adb, unless TwinDesk uses them unsafely.
