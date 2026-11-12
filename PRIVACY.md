# TwinDesk Privacy Policy

_Last updated: 12 November 2026_

TwinDesk connects your own computers, phones and tablets so they work as one desk. It is free, open source software (GPL-3.0), made by one developer, Inuka Asith. This policy covers TwinDesk on every platform (Windows, including the Microsoft Store version, macOS, Linux, Android, iPhone and iPad, and TwinDesk Web).

## The short version

- **No account.** TwinDesk has no sign-up and no TwinDesk server.
- **No tracking.** No analytics, advertising, telemetry or crash reports are sent anywhere.
- **Your data stays on your devices.** Your screen, input, clipboard, files, notifications, calls and messages go directly between your own paired devices, encrypted.
- **We never see it.** The developer has no way to see, collect or sell your data.

## What TwinDesk handles, and where it goes

### Between your devices

When you pair devices, TwinDesk sends the content of the features you use directly from one of your devices to another. This happens over your local network, Bluetooth or a USB cable. That content can include:

- screen images and audio
- mouse, keyboard, touch and pen input
- clipboard contents
- files you send or drag
- notifications from your phone, with their text and pictures
- calls (ringing, answering, dialling, contact names and numbers, and call audio)
- text messages, contacts and call history the phone app shows
- photos and files you choose to open from the phone
- the apps you open from the other device
- shared folders, and the terminal when you turn it on

Each pairing is confirmed on both devices. Connections between paired devices are encrypted (TLS, pinned to that pairing). Nothing goes through a server run by TwinDesk.

### TwinDesk Web

If you turn on TwinDesk Web, your computer serves TwinDesk's pages to browsers on your local network. A browser can only use them after you pair it.

### Stored on your devices

TwinDesk keeps these on the device they belong to:

- settings and pairing keys
- received files, in the folder you choose
- logs of what the app did, to attach to a bug report if you want; they never leave your computer unless you send them yourself

If you turn on **Keep history**, your clipboard history and phone notifications are kept encrypted, for as long as you choose. You can clear them at any time. Uninstalling TwinDesk, or deleting its folder, removes them.

### Phone permissions (Android)

The Android app asks for permissions only for the features that need them, such as:

- notifications, calls, contacts and call history: for the calls and notifications features
- photos and files: for browsing them from your computer
- microphone: for call and sound sharing
- screen capture: for mirroring your phone
- nearby devices and location: Android requires location access to find devices and Wi-Fi networks nearby. TwinDesk does not record or send your location.

What these permissions give access to is used only for TwinDesk's features, and it goes only to your own paired devices.

## Services TwinDesk contacts

TwinDesk itself runs no server. It contacts these outside services only for the purposes described:

- **GitHub** (github.com, api.github.com)
  - **Why:** to check for new versions of TwinDesk and download them (not in the Microsoft Store version, which the Store updates), and to download optional parts when you turn on a feature that needs them (for example a display or gamepad driver, or TwinDesk for iPhone).
  - **What is sent:** an ordinary web request. No personal data.
- **Apple** (only if you use *Install on iPhone*)
  - **Why:** to sign TwinDesk for your iPhone or iPad with your own Apple ID and install it. TwinDesk signs in to Apple the way Apple's developer tools do.
  - **What is sent:** your Apple ID and password, sent only to Apple and used only for that sign-in. TwinDesk never stores your password. The certificate and sign-in session it needs to renew the app are kept on your iPhone, in its Keychain. Unless you turn *Keep a copy* off, an encrypted copy is also kept on your computer, protected by the system's secure storage.
- **Anisette server** (only if you use *Install on iPhone*)
  - **Why:** Apple's sign-in needs device identification data, which TwinDesk gets from a public anisette server (`ani.iloader.app`, run by a third party).
  - **What is sent:** TwinDesk never sends your Apple ID or password to it. The server does hold the device identity that Apple trusts after you complete two-factor verification.
- **Links you open** (the website, the source code)
  - These open in your browser, under that website's own policy.

The Microsoft Store, Google Play, Apple and other stores you get TwinDesk from have their own privacy policies for what they collect about installs and purchases.

## Children

TwinDesk does not knowingly collect any data from anyone, including children under 13.

## Your choices

- Every feature that shares something can be turned off. So can every pairing.
- Uninstalling TwinDesk stops all of it.
- You can delete TwinDesk's data folder:
  - `%APPDATA%\MacShare` on Windows
  - `~/Library/Application Support/MacShare` on macOS
  - `~/.config/MacShare` on Linux

Because TwinDesk doesn't collect your data, there is nothing on our side to request, export or delete.

## Changes

If this policy changes, the new version is published here with a new date. The full history is in the project's source code.

## Contact

Questions about privacy: open an issue at <https://github.com/InukaAsith/TwinDesk/issues>.
