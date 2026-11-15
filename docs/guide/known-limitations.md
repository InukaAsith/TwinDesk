# Known limitations

What TwinDesk can't do yet, or can't do because of the operating system. Each line links to its
issue when there is one.

## Every platform

- **Not code-signed.** macOS and Windows ask once before opening TwinDesk (see
  [Getting started](getting-started.md#2-first-launch)), and some antivirus engines flag the
  unsigned installer (#12).
- **Away from home needs Tailscale.** Off the local network, devices reach each other over a
  Tailscale tailnet, Bluetooth, Wi-Fi Direct or a cable. There's no TwinDesk relay server.
- **Pairing tokens are files** protected by your account's file permissions, not the keychain
  ([SECURITY.md](../../SECURITY.md#known-limitations)).

## Windows

- **UAC prompts and the lock screen** are on Windows' secure desktop, which normal apps can't reach.
  The mouse from another computer stops there until you use the PC's own (#210).
- **Windows on ARM: no Extend.** Windows' code integrity rejects the virtual display driver (#14).
- **Smart App Control** blocks unsigned apps with no Run anyway.
- **Call sound with a Bluetooth headset.** While a Bluetooth headset is connected to the PC, calls
  stay on the phone: Windows plays a phone's calls only through wired or built-in speakers and microphone.

## Mac

- **Notarization.** The DMG isn't notarized, so Gatekeeper asks once (#75).

## Linux

- **Wayland:** dragging files out of Linux and opening its apps in windows on the other computer
  need an Xorg session.
- **Extend on X11** needs a spare output from the graphics driver, which NVIDIA's driver doesn't have.
- **KDE Plasma on Wayland:** identify labels can overlap (#182), and the phone's touchpad can't reach
  a second monitor (#183).
- **x86_64 only.**

## Android

- **Wireless debugging** (Android 11 or later) is needed for the screen, apps in windows, touch, the
  camera and the phone's sound. Files, clipboard, notifications, calls, texts and photos don't need it.
- **Samsung DeX:** the shared pointer can't move from the tablet to an external DeX display (#127).
- **The phone connects to one computer at a time** in one-to-one mode. Multi-device lifts that.

## iPhone and iPad

- **No App Store version.** The IPA is installed with AltStore, SideStore or the computer's TwinDesk
  iPhone page, and a free Apple ID's signature lasts 7 days, so it's refreshed by itself.
- **No calls, texts or the phone's storage.** iOS gives no app access to them.
- **The computer's mouse doesn't cross onto an iPhone.** iOS doesn't allow input from other apps.
- **In the background**, the session moves to Bluetooth, and screens and big files wait until
  TwinDesk is open again.

## Multi-device (Mesh)

- Up to **10 devices** at once.
- **ReZume** works with one device at a time: pick it under ReZume with. Documents travel through Files,
  so the device you pick becomes the selected one while a document goes. App windows and documents edited
  in place are one-to-one only.
- **Mouse and keyboard over Bluetooth** works between Macs and Windows PCs. A session the Mac dialled
  has no Bluetooth path, and Linux joins other computers over the network only.
- **TwinDesk iPhone** signs one iPhone at a time.
- With only two devices, keep Multi-device off: one-to-one has everything, with less to set up.
