<p align="center">
  <img src=".github/assets/icon.png" width="112" alt="TwinDesk icon">
</p>

<h1 align="center"><a href="https://twin-desk.vercel.app">TwinDesk</h1></a>

<p align="center">
  Use two computers as one desk: Mac, Windows and Linux on the same network.<br>
  Share screens, mouse and keyboard, clipboard, files, sound, notifications, terminals and apps.
</p>

<p align="center">
  <img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue">
  <img alt="macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-black">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4">
  <img alt="Linux X11 and Wayland" src="https://img.shields.io/badge/Linux-X11%20%7C%20Wayland-f0a30a">
</p>


<p align="center">
  <img src=".github/assets/hero.svg" alt="A Mac and a PC side by side, linked by TwinDesk" width="100%">
</p>

TwinDesk pairs two computers on your local network. One app on each side does the job of a
software KVM, a second-monitor app, a clipboard and file-sharing tool and a remote-app viewer.
Everything travels directly between the two machines over an encrypted link. There's no cloud
account and no relay server.

<p align="center">
  <img src=".github/assets/tour.gif" alt="A tour of the TwinDesk window" width="820">
</p>

## What you can do

| | |
|---|---|
| **🖥 Use one computer as a second screen**<br>Extend your Mac onto the PC with a real virtual display, or mirror it. Or bring the PC's screen into a window on the Mac, with Extend through a virtual display driver. Low-latency H.264 over WebRTC, with Fastest / Smooth playback and optional frame generation. | <img src=".github/assets/ui-share-screen.jpg" alt="Share screen settings" width="420"> |
| **🖱 One mouse and keyboard for both**<br>Push the pointer off the edge of the screen and keep working on the other computer. Pick which side the other computer is on, set edge resistance and pointer speed. Double-tap the hotkey (Right Option / Right Alt by default) to bring everything home. Trackpad gestures, like Spaces swipes, pinch to zoom and show desktop, carry over too. | <img src=".github/assets/ui-cursor.jpg" alt="Cursor settings" width="420"> |
| **📋 Clipboard both ways**<br>Copy on one computer and paste on the other, instantly or when you switch. Password managers' entries are skipped, and there's a short Recent list. | <img src=".github/assets/ui-clipboard.jpg" alt="Clipboard settings" width="420"> |
| **📁 Files and folders**<br>Drag files across the screen edge and drop them anywhere, or copy with <kbd>⌃⌥C</kbd> and paste with <kbd>⌃⌥V</kbd> (<kbd>Ctrl+Alt+C/V</kbd> on Windows). You can also send from the macOS Share menu or Explorer's *Send to*, and share a folder that shows up as a network drive on the other side. | <img src=".github/assets/ui-files.jpg" alt="Files settings" width="420"> |
| **🪟 Apps from the other computer**<br>Open the PC's apps on the Mac (or the Mac's apps on the PC), each in its own window with its own Dock icon or Start-menu pin. Menus and pop-ups work too. | <img src=".github/assets/ui-apps-on.jpg" alt="Apps from the other computer" width="420"> |
| **🔔 Notifications**<br>See one computer's notifications on the other as native notifications. You can hide the message text or mute single apps. | <img src=".github/assets/ui-notifications.jpg" alt="Notifications settings" width="420"> |
| **⌨️ Terminal**<br>Open a shell on the other computer without passwords, between any two computers. Keys are exchanged over the paired link, so `ssh twindesk` just works in any terminal. | <img src=".github/assets/ui-terminal.jpg" alt="Terminal settings" width="420"> |
| **🔊 Sound**<br>Hear one computer on the other, in either direction, separate from screen sharing. | <img src=".github/assets/ui-audio.jpg" alt="Audio settings" width="420"> |

TwinDesk also includes:

- **Discovery and pairing.** Computers find each other on the LAN. You pair once by comparing a
  code, and after that the link is TLS-encrypted and pinned to the pair.
- **Settings stay in sync.** A two-way switch is one setting shared by both computers, remembered
  per pair.
- **Wake-on-LAN.** Wake a paired computer from the other one.
- **Device names.** Every label uses your computers' real names.
- **Update checks.** Each app looks for new [releases](https://github.com/InukaAsith/TwinDesk/releases)
  on start and every few hours, shows a notification and offers the download for your platform
  (About › Updates, or the menu bar / tray).

<p align="center">
  <img src=".github/assets/ui-overview.jpg" alt="Overview: both computers, the link and what is shared in each direction" width="820">
</p>

## Platforms

| Pair | Status |
|---|---|
| Mac ↔ Windows PC | Every feature above |
| Mac ↔ Mac | Every feature above |
| PC ↔ PC | Every feature above |
| Linux ↔ Mac, PC or Linux | Screen (Mirror), mouse and keyboard, clipboard, sound, Send files, notifications, terminal, apps and wake-on-LAN |

On Linux, TwinDesk runs on both X11 and Wayland. On Wayland, the mouse and keyboard go through
evdev and uinput (the Setup screen grants access once), and screens are captured through the
desktop portal. Opening this computer's apps on the other side needs an Xorg session. These aren't
on Linux yet: the shared folder, copy and paste of files with shortcuts, dragging files across the
screen edge, and Extend.

## How it works

<p align="center">
  <img src=".github/assets/how-it-works.svg" alt="Architecture: an Electron app and a native helper on each computer, linked by a TLS control channel, WebRTC media and system services" width="100%">
</p>

Each computer runs an **Electron app**, which handles the window, pairing, the link and the state
machines. Next to it runs a small **native helper** for everything the OS keeps to itself:
capturing and injecting input, virtual displays, gestures, window capture and native drag and drop.

| Folder | What's in it |
|---|---|
| `mac/` | macOS app (Electron) |
| `mac-helper/` | macOS helper (Swift): virtual display, event tap, input injection, audio, apps, SMB |
| `windows/` | Windows app (Electron) and installer |
| `windows-helper/` | Windows helper (C#): hooks, SendInput, Raw Input touchpad, window capture, native drag |
| `linux/` | Linux app (Electron) |
| `linux-helper/` | Linux helper (C): XInput2 / XTest on X11, evdev / uinput on Wayland, XRandR, window list |
| `shared/` | Wire protocol, frame generation and icons used by every app |

Ports: TCP **47800** (control link) and UDP **47801** (discovery) on the local network.

## Build and run

You need [Node.js](https://nodejs.org) 18+ on every platform.

### macOS (13 Ventura or later)

```sh
xcode-select --install          # Swift compiler for the helper
cd mac
npm install
npm run build:helper
npm start                       # run from source
npm run dist && npm run dmg     # build TwinDesk.app and TwinDesk.dmg in mac/dist/
```

On first launch, TwinDesk asks for **Screen Recording**, **Accessibility** and **Input
Monitoring**. The General tab shows each permission's status.

### Windows 10 / 11

```bat
cd windows
npm install
npm run build:helper            :: uses the .NET Framework C# compiler that ships with Windows
npm start
npm run dist                    :: NSIS installer in windows\dist\
```

The Setup screen offers to add the firewall rule and set the network to Private. It can also
install the optional Virtual Display Driver for Extend.

### Linux (X11 or Wayland)

```sh
sudo apt install build-essential libx11-dev libxi-dev libxtst-dev libxrandr-dev libxfixes-dev
cd linux
npm install
npm run build:helper
npm start
npm run dist                    # AppImage and .deb in linux/dist/
```

The Setup screen walks you through the rest. On Wayland that means input access (one admin
prompt, then log out and back in once). It can also install OpenSSH for the terminal.


## Privacy

TwinDesk only talks to computers you have paired with, directly over your local network. It has no
accounts, telemetry or cloud relay. The only internet request is the update check, which asks
GitHub's public API for the latest release (it can be turned off in About › Updates).
Shared-folder passwords are random and kept in the OS keychain (macOS) or encrypted with DPAPI
(Windows).

## License

TwinDesk is free software, licensed under the [GNU General Public License v3.0](LICENSE).
Copyright © 2026 inukaasith.

Parts are adapted from [DeskPad](https://github.com/Stengo/DeskPad) (MIT). See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)
for details.
