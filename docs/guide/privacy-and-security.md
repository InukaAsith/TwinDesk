# Privacy and security

## What leaves your devices

- **Nothing goes through a server.** Devices talk to each other directly: the local network,
  Bluetooth LE, Wi-Fi Direct or a phone's hotspot, a USB cable, or your own Tailscale tailnet. There
  are no TwinDesk accounts, servers or relays, and no telemetry.
- **The update check** asks GitHub's public releases for a newer version. Turn it off in General ›
  Updates.
- **TwinDesk Web's notifications** are Web Push sent by your computer itself.
- **Voice typing** in Remote uses the phone's own speech recognizer, which may use its maker's
  servers.
- **TwinDesk iPhone** (opt in) signs in to Apple with your Apple ID, and uses one "anisette" server
  that Apple's sign-in needs. That server never gets your Apple ID or password.

Your calls, texts, photos, camera and screen go from one of your devices to another and nowhere else.

## You decide what's shared

- Every feature is **off on a new install** and isn't loaded until you turn it on.
- Two-way features have **a switch for each direction**, kept in step on both devices.
- **ReZume** is off until you turn it on, and you choose which apps it may send.
- **Notifications** can hide message text, and each app can be muted.
- **Passwords** that a password manager marks as private are never sent on the clipboard.
- **Clipboard and notification history** are kept only when you ask, encrypted, for as long as you
  choose.
- **Forget** a device (Connection › Forget) and its token stops working at once.

## How a session is protected

- **Pairing** happens once, confirmed by the person at each device with a 6-digit code that neither
  side can choose. Five failed pairings from an address within 10 minutes lock it out.
- **Every session is TLS**, pinned to the paired device's certificate, wherever it runs.
- **The input lane** (UDP) uses AES-256-GCM with per-session keys and a replay window.
- **Files** are encrypted by default. Files › Encrypt file transfers off sends file bytes without
  encryption on the local network, for speed, still checked and still behind a per-session token.
- **Linux input access** goes to TwinDesk's helper alone, never to your account's `input` group.

The full model, its limits and how to report a vulnerability are in [SECURITY.md](../../SECURITY.md).
The privacy policy is [PRIVACY.md](../../PRIVACY.md).
