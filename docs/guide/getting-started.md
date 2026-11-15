# Getting started

## 1. Install

Get TwinDesk for each device from the [download table](../../README.md#download), or:

| Device | Also |
|---|---|
| Mac | `brew install --cask inukaasith/twindesk/twindesk` (opens without the Gatekeeper steps below) |
| Debian, Ubuntu, Mint, Pop!_OS | the [APT repository](../../README.md#apt), kept up to date by `apt upgrade` |
| Arch | the `.pkg.tar.zst` from the release |
| NixOS | `nix run github:InukaAsith/TwinDesk` ([more](../nixos.md)) |
| Android | the `.apk`. The computer can install the full app for you later |
| iPhone and iPad | no app: [TwinDesk Web](#iphone-or-ipad-without-an-app). Or the IPA through AltStore or SideStore |

Updates come through the app itself (About), Homebrew or APT.

## 2. First launch

The apps aren't code-signed by Apple or Microsoft yet, so each OS asks once.

**Mac.** Open TwinDesk. When macOS says it can't verify it, click **Done**, then **System Settings ›
Privacy & Security › Open Anyway**. If it says TwinDesk **is damaged**, it isn't. Run
`xattr -dr com.apple.quarantine /Applications/TwinDesk.app` and open it again. Then the Setup screen
asks for **Screen Recording**, **Accessibility** and **Input Monitoring**.

**Windows.** Choose **Keep** if the browser warns, then **More info › Run anyway** on SmartScreen.
Allow the firewall rule. With **Smart App Control** on, Windows 11 blocks unsigned apps with no way
past it except turning it off. For **Extend**, Share screen installs the virtual display driver.

**Linux.** On Wayland, Setup's **Fix** gives TwinDesk's helper input access with one password prompt.
It never adds your account to the `input` group. Then log out and back in once. Setup also opens the
firewall for TwinDesk's ports and mDNS.

**Android.** Allow your browser or Files app to install apps, and if Play Protect warns, **More
details › Install anyway**. Android 13 and later grey out notification access and Accessibility in
an app installed by hand: **Settings › Apps › TwinDesk › ⋮ › Allow restricted settings**.

## 3. Pair

Open TwinDesk on both devices. They find each other on the same network, over Bluetooth, or over a
phone's USB cable.

- **Computer and computer.** Pick the other computer and check that both show the same 6-digit code.
- **Phone.** On the phone, Connect › Nearby, or scan the computer's QR code. On a USB cable, click
  **Allow**.
- **Away from home.** Both devices on the same [Tailscale](https://tailscale.com) tailnet find each other.

You pair once. After that, devices connect by themselves whenever they can reach each other.

## 4. Turn on what you want

Every feature starts off and isn't loaded until you switch it on. Each two-way feature has a switch
per direction, named after your devices. General › Modules hides pages you never use.

## Android: wireless debugging, once

Files, the clipboard, notifications, calls, texts and photos work right away. The phone's **screen**,
its **apps in windows**, **touch**, your **mouse and keyboard on the phone**, its **camera** and its
**sound** go through wireless debugging:

1. Connect › the wireless debugging card (on the computer or the phone) walks you through it.
2. On the phone: **Developer options › Wireless debugging › Pair device with pairing code**, and type
   the code on the computer, or in TwinDesk's notification on the phone.
3. From then on TwinDesk turns wireless debugging on when it needs it and follows its port.

**Xiaomi, Redmi and POCO** also need **Developer options › USB debugging (Security settings)**,
or the screen shows but taps are refused.

The **full app** (notification access, texts and Accessibility) is installed by the computer over
wireless debugging (Phone › Notifications from the phone). Your settings and pairing stay.

## iPhone or iPad without an app

Turn on **TwinDesk Web** on a computer, then type `twindesk.local` in Safari on the iPhone and pair
with the QR code or the code. **Share › Add to Home Screen** makes it an app. For more (Share Screen,
background Bluetooth, Photos), install the IPA with AltStore or SideStore, or let the computer sign
it with your Apple ID (TwinDesk iPhone page).

## Many devices at once

Two devices work one-to-one out of the box. For three or more at the same time, turn on
**Multi-device** ([how it works](../multi-device.md)). With only two devices, keep it off.

Stuck? See [Troubleshooting](troubleshooting.md).
