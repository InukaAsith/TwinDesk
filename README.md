<p align="center">
  <img src=".github/assets/icon.png" width="112" alt="TwinDesk icon">
</p>

<h1 align="center"><a href="https://twin-desk.vercel.app">TwinDesk Mesh</a></h1>

> **TwinDesk Mesh** is a fork build of [TwinDesk](https://github.com/InukaAsith/TwinDesk). It has its own app identity (Android `com.twindesk.mesh`, macOS `org.macshare.mesh`, own Windows/Linux names and data folders), so it installs **next to** upstream TwinDesk and neither replaces the other. It speaks the same network protocol, so Mesh and upstream builds still pair and talk to each other. Both use the same default ports, so run only one of them at a time on one computer. On first start it copies (never moves) upstream's settings and pairings. Android data cannot move across package ids: pair the phone again.

<p align="center">
  <b>All your computers and your phone, working as one desk.</b><br>
  Screens, apps, files, clipboard, calls, texts, notifications, mouse and keyboard, shared between Mac, Windows, Linux and Android.<br>
  Free and open source. No account, no cloud, and now no shared network needed.
</p>

<p align="center">
  <a href="https://github.com/InukaAsith/TwinDesk/releases/latest"><b>⬇️ Download 2.1</b></a> ·
  <a href="https://twin-desk.vercel.app"><b>Website</b></a> ·
  <a href="#-new-in-21"><b>What's new</b></a> ·
  <a href="#under-the-hood"><b>How it works</b></a>
</p>

<p align="center">
  <img alt="Version 2.1" src="https://img.shields.io/github/v/release/InukaAsith/TwinDesk?label=version&color=4b8bff">
  <img alt="macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-black">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4">
  <img alt="Linux X11 and Wayland" src="https://img.shields.io/badge/Linux-X11%20%7C%20Wayland-f0a30a">
  <img alt="Android 10+" src="https://img.shields.io/badge/Android-10%2B-3ddc84">
  <img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue">
</p>

<p align="center">
  <img src=".github/assets/hero.jpg" alt="One Mac's extended screen in a window on another Mac, the Mac's desktop extended onto a tablet, and TwinDesk on a phone" width="100%">
</p>

Your devices are good at their own jobs and bad at working together. TwinDesk fixes that.
Put a **Mac and a Windows PC** side by side and use them with one mouse and keyboard. Open the
PC's apps on the Mac. Turn an old laptop or your **Android tablet** into a second screen. Answer
your **phone's calls and texts** from the computer, send a file in two taps, and paste on one
device what you copied on another.

- **Any combination.** Mac ↔ Windows, Mac ↔ Mac, PC ↔ PC, Linux ↔ anything, and Android ↔ any computer.
- **Anywhere.** Same Wi-Fi, a USB cable, or no shared network at all: Bluetooth and a direct Wi-Fi link of their own.
- **No account, no cloud.** Devices talk only to each other, on an encrypted link.
- **No extra hardware, no root.** Install the app on each device and pair once.

<table>
<tr>
<td width="33%" valign="top">

### 💻 [Computer features](#-computer-features)
One mouse and keyboard · second screen · the other computer's apps in windows · files and folders · clipboard · terminal · sound · notifications

</td>
<td width="33%" valign="top">

### 📱 [Phone and tablet features](#-phone-and-tablet-features)
Phone screen and apps in windows · tablet as a second screen · **calls** · **texts** · **photos** · **phone files** · share menu · clipboard · notifications

</td>
<td width="33%" valign="top">

### 📡 [Connectivity features](#-connectivity-features)
**Bluetooth** sessions · **Wi-Fi Direct** and **hotspot** links made on demand · USB cable · same Wi-Fi · picked for you, moved for you

</td>
</tr>
</table>

---

# ✨ New in 2.1

<p align="center">
  <img src=".github/assets/v21-whats-new.jpg" alt="TwinDesk 2.1: the Overview over Bluetooth and the Calls page with an incoming call" width="100%">
</p>

TwinDesk 2.1 is the biggest update yet. Devices no longer need to be on the same network, and the
phone is now on your computer in full: its calls, texts, photos and files.

| | What's new | |
|---|---|---|
| 📡 | **Bluetooth sessions.** Phones and computers nearby connect with no shared network | [More](#-bluetooth-connection) |
| ⚡ | **Wi-Fi Direct and hotspot.** A fast link of their own for files, screens and apps, made when needed | [More](#-wi-fi-direct-and-hotspot) |
| 📞 | **Calls.** Answer, decline and dial; talk and listen on the computer | [More](#-calls) |
| 💬 | **Messages.** Read and reply to your texts | [More](#-messages) |
| 🖼 | **Photos.** Browse the phone's photos and videos, save them to the computer | [More](#-photos-and-phone-files) |
| 🗂 | **Phone Files and shared folders.** The phone's storage on the computer, folders shared both ways | [More](#-photos-and-phone-files) |
| ✨ | **And more.** Pair over USB, live file progress, Take over and Switch, mouse and keyboard without developer options | [More](#-more-in-21) |

<sub>The 2.1 screenshots are the real app. The people, texts and photos in them are demo data.</sub>

# 📡 Connectivity features

## 📶 Bluetooth connection

On a train, in a café with guest Wi-Fi that blocks devices, or with no Wi-Fi at all: devices that
are near each other now **connect over Bluetooth LE** by themselves. The session, mouse and keyboard,
clipboard, notifications, calls and texts all run over it, and the status line says so
(*38 ms · Bluetooth*). It works between a phone and any computer, and between computers too: a Mac
and a Windows PC, or Linux.

<p align="center">
  <img src=".github/assets/v21-bluetooth.jpg" alt="The Overview with a phone connected over Bluetooth, and a Mac driving a Windows PC over Bluetooth" width="100%">
</p>

Two switches decide who can turn up over Bluetooth: **Bluetooth with phones** (on) and **Bluetooth
with computers** (off until you want it), on the Overview and in General. *Turn off Bluetooth on
Wi-Fi connections* (on by default) switches the radio off once both devices are on the same Wi-Fi
and brings it back when that Wi-Fi goes.

## ⚡ Wi-Fi Direct and hotspot

Bluetooth is great for the session but too slow for a screen or a big file. So when you start one,
TwinDesk **brings up a direct Wi-Fi link** between the two devices for as long as it's needed, then
goes back to Bluetooth (*Temporary Wi-Fi Direct*). Want it to stay? Press **Connect with Wi-Fi
Direct** on either side, and **Back to Bluetooth** when you're done. A phone can also share its
**hotspot**: the computer joins it, with the name and password typed once and remembered.

<p align="center">
  <img src=".github/assets/v21-wifi-direct.jpg" alt="The Overview on Wi-Fi Direct with Back to Bluetooth, and General's network settings" width="100%">
</p>

## 🔗 Automatic link selection

<p align="center">
  <img src=".github/assets/v21-connections.jpg" alt="Same Wi-Fi, Bluetooth LE, Wi-Fi Direct, phone hotspot and USB cable" width="100%">
</p>

You never have to choose. TwinDesk uses the same network when there is one, moves a phone onto
the **USB cable** when you plug it in (and back when you unplug), and falls back to Bluetooth when
the Wi-Fi goes. The link and its latency are always shown at the top of the app.

| | Same Wi-Fi | USB cable | Bluetooth | + Wi-Fi Direct or hotspot |
|---|:-:|:-:|:-:|:-:|
| Session, clipboard, notifications | ✅ | ✅ | ✅ | ✅ |
| Mouse and keyboard | ✅ | ✅ | ✅ | ✅ |
| Calls and texts | ✅ | ✅ | ✅ | ✅ |
| Screens, apps, files, photos, shared folders | ✅ | ✅ | moves to Wi-Fi Direct | ✅ |
| Phone's screen through wireless debugging | ✅ | ✅ | moves to Wi-Fi Direct | ✅ |
| Terminal between computers (`ssh twindesk`) | ✅ | — | on Wi-Fi Direct | ✅ |

# 💻 Computer features

## 🖱 Shared mouse and keyboard

Push the pointer off the edge of your screen and **keep working on the other computer**, as if
they were one. Your keyboard follows the pointer. Trackpad gestures (Spaces swipes, pinch to zoom,
show desktop) carry over, and a double-tap of the hotkey brings everything home. Set which side the
other computer is on, edge resistance and pointer speed. It works over Bluetooth too (*Over
Bluetooth* on the Cursor page).

## 🖥 Extended display and remote screen

Extend your Mac onto a PC or another Mac with a **real virtual display**, or mirror it. Or bring
the other computer's screen into a window and control it from there. Low-latency H.264 with
*Fastest* and *Smooth* playback, and optional frame generation. On Windows, a toolbar slides in at
the top of the window for Extend or Mirror, Stop, frame generation and full screen.

<p align="center">
  <img src=".github/assets/mac-screen-window.jpg" alt="The MacBook Pro's extended screen in a window on the Studio Mac, with the Receive screen settings" width="100%">
</p>

## 🪟 Remote apps in their own windows

Open a **Windows app on your Mac** (or a Mac app on your PC) and it gets **a window of its own**,
with its own Dock icon or Start-menu pin. No full remote desktop, just the app you need, next to
your own.

<p align="center">
  <img src=".github/assets/mac-apps.jpg" alt="Chess, Clock and Calculator from one Mac running in their own windows on the other Mac" width="100%">
</p>

Pick any app from the other computer's list and it opens in a moment:

<p align="center">
  <img src=".github/assets/computers-apps-cursor.jpg" alt="The other Mac's apps listed on the Apps page, and the Cursor page with the screen layout" width="100%">
</p>

## 📁 File transfer, shared folders and terminal

**Drag files across the screen edge** and drop them anywhere, or copy with <kbd>⌃⌥C</kbd> and
paste with <kbd>⌃⌥V</kbd> (<kbd>Ctrl+Alt+C/V</kbd> on Windows and Linux). Send from the macOS Share
menu or Explorer's *Send to*, or **share a folder** that shows up as a network drive on the other
side. Files on their way show **live progress** (a progress notification, or on the Mac the percentage beside the menu bar icon). Need a shell? `ssh twindesk`
opens one on the other computer, no passwords needed.

<p align="center">
  <img src=".github/assets/computers-files.jpg" alt="The Files page and the Terminal page" width="100%">
</p>

## 📋 Shared clipboard

Copy on one computer and paste on the other, instantly or when you switch over. Entries from
password managers are skipped, and a Recent list keeps the last few things you copied.

<p align="center">
  <img src=".github/assets/computers-clipboard.jpg" alt="The same copied text in the clipboard history on both Macs" width="100%">
</p>

## 🔔 Notifications, sound and Wake-on-LAN

See one computer's notifications on the other as native notifications, and hear one computer's
sound on the other. Wake a sleeping computer with Wake-on-LAN, and every switch you flip is
shared by both sides and remembered for the pair.

## 🔀 Multiple devices

Pair as many computers and phones as you like. **Switch** moves the session to another paired
device nearby, **Take over** claims one that's busy with someone else, and **Disconnect** lets go:
a device let go stays away until you connect it again. All from the Overview, the menu bar or the
tray.

## 🤝 Cross-platform pairing

The same app on every platform, so a Mac and a PC pair just like two Macs. Here's a Mac connected to
a Windows PC, with the PC's apps ready to open on the Mac:

<p align="center">
  <img src=".github/assets/mac-windows.jpg" alt="A Mac connected to a Windows PC, and the PC's apps listed on the Mac" width="100%">
</p>

<p align="center">
  <img src=".github/assets/computers-overview.jpg" alt="Overview on two paired Macs: the link, latency and what is shared in each direction" width="100%">
</p>

# 📱 Phone and tablet features

Most phone links stop at notifications and a file drop. In TwinDesk your Android phone or tablet is
a **full peer**: it pairs like a computer and gets the same features, plus its calls, texts, photos
and files.

## 📞 Calls

Answer, decline and make your phone's calls from the computer. When it rings, a small window shows
who's calling with **Answer** and **Decline**, then the time, **Mute**, **End** and where the sound
is. The **Calls** page has a number pad, contacts found as you type, all your contacts and the call
history.

With Bluetooth, the computer becomes **the phone's headset**, so you talk and listen right there
(Mac, Windows, and Linux with PipeWire). Pair the two once in the system's Bluetooth settings, and
the Calls page walks you through it.

## 💬 Messages

Read and reply to your texts on the **Messages** page: every conversation, pictures included, new
ones as they arrive, and a count in the sidebar. Start a new conversation by number.

<p align="center">
  <img src=".github/assets/v21-calls-messages.jpg" alt="The Calls page with an incoming call and the call history, and the Messages page with a conversation" width="100%">
</p>

## 🖼 Photos and phone files

Browse the phone's **photos and videos** on **Photos** (all, photos, videos or screenshots), open
any of them big, and save one or many to the computer. **Phone Files** browses the phone's whole
storage: open folders, save to the computer, upload, rename, delete and make folders, or just drop
files on the page. It's TwinDesk on the phone doing it, so no developer options are needed.

**Shared folders work both ways:** a folder the phone shares opens in **Finder, Explorer or the
Linux file manager**, and a folder you share from the computer shows up in the phone's **Files app
and file pickers**.

<p align="center">
  <img src=".github/assets/v21-photos-files.jpg" alt="The Photos page with the phone's gallery, and Phone Files with shared folders and the phone's storage" width="100%">
</p>

Calls, Messages, Photos and Phone Files are each **off until you switch them on**. Off means nothing
of it runs on either side, and the phone asks for its permissions only then, at the top of that
page, never during setup. Their tabs show only while a phone is connected.

## 📲 Phone screen and apps on the computer

See your phone's screen in a window and control it with your mouse, trackpad and keyboard. Better
still, open **single Android apps in windows of their own**, side by side with your desktop apps.
Pin them to the Dock or the Start menu and use them like any other app.

<p align="center">
  <img src=".github/assets/phone-on-mac.jpg" alt="The tablet's home screen in a Mac window, and Calculator, Calendar and Clock open as separate Mac windows" width="100%">
</p>

Every app on the phone is one click away from the computer's Phone page, along with its battery,
the connection and a button to bring up the whole screen.

<p align="center">
  <img src=".github/assets/mac-phone-page.jpg" alt="The Phone page on the Mac: the connected tablet and a grid of its apps" width="720">
</p>

## 🖥 Tablet as a second screen

Turn a tablet or phone into an **extra monitor**. Choose **Extend** to get more desktop space, or
**Mirror** to show what's on your screen. Drag windows onto it, and use touch as the mouse: tap to
click, hold to right click, two fingers to scroll. Start it from the computer or from the tablet
itself.

<p align="center">
  <img src=".github/assets/second-screen.jpg" alt="Share screen settings on the Mac, and the tablet showing the extended Mac desktop" width="100%">
</p>

## 📤 File sharing

Share a photo or a document from **any Android app**: pick *Send to computer* or *Copy to computer*
in the system share menu. On the computer, use the **macOS Share menu**, **Explorer's Send to**, drag
files across the screen edge, or press <kbd>⌃⌥C</kbd> / <kbd>Ctrl+Alt+C</kbd> to copy them and paste
them anywhere on the phone. Files arrive with a notification you can tap to open.

<p align="center">
  <img src=".github/assets/share-files.jpg" alt="The Mac's Files page, the Android share menu with Send to computer and Copy to computer, and a received-file notification on the tablet" width="100%">
</p>

## 📋 Clipboard sync

Copy text on your computer and paste it on your phone, or the other way around. It's instant, it
works in the background, and a Quick Settings tile sends the phone's clipboard with one tap.

<p align="center">
  <img src=".github/assets/clipboard.jpg" alt="The same copied text in the clipboard history on the Mac and on the tablet" width="100%">
</p>

## 🖱 Mouse and keyboard on the phone

Push the pointer past the edge of your screen and it **carries on onto the phone**. Type with your
real keyboard in any Android app, scroll with your trackpad, then double-tap the hotkey to come back.
It goes through wireless debugging, or through **Accessibility** with no developer options at all
(over Bluetooth too); TwinDesk picks automatically, or you choose on the Cursor page.

<p align="center">
  <img src=".github/assets/mouse-keyboard.jpg" alt="Cursor settings on the Mac and on the phone, with the device layout" width="100%">
</p>

## 🔔 Notification sync

Your phone's notifications show up on your computer as **native notifications**, and the
computer's can show up on your phone. Hide the message text for privacy or mute single apps.

<p align="center">
  <img src=".github/assets/notifications.jpg" alt="Notification settings on the Mac and on the phone" width="100%">
</p>

## 📱 Android app

The Android app adapts to the device: tabs at the bottom on a phone, a full sidebar on a tablet.
Every page names the computer you're connected to and shows what's shared in each direction.

<p align="center">
  <img src=".github/assets/android-phone.jpg" alt="The Android app on a phone: Overview, Screen, Files, Clipboard and More" width="100%">
</p>

<p align="center">
  <img src=".github/assets/android-tablet.jpg" alt="The Android app on a tablet: Overview and Files" width="100%">
</p>

You also get **Quick Settings tiles** (*Send clipboard*, *Wireless debugging*), **home screen
shortcuts** to the computer's screen, an ongoing notification with what's connected, and **sound**
in both directions (the phone captures its own sound now, no wireless debugging needed).

## ✨ More in 2.1

- **Pair a phone over the USB cable.** Plug it in and click Allow on the computer: no code to compare.
- **The phone as a drive on Windows and Linux** too (Mount), as it already was in Finder.
- **Live progress for files** everywhere: a progress notification on Windows, Linux and the phone, the percentage beside the menu bar icon on the Mac.
- **Switch, Take over and Disconnect** for every session, on the Overview and in the menu bar or tray.
- **Mouse and keyboard on the phone without developer options**, through Accessibility.
- **The phone's sound without wireless debugging**: the phone captures it itself.
- **Monitor 2 toolbar on Windows**, as on the Mac's viewer.
- **Windows reliability:** mouse sharing keeps working from the tray, the pointer never stays blank
  after a UAC prompt, and scrolling on the other computer no longer scrolls the app under the parked
  pointer.
- **Linux:** Bluetooth LE through BlueZ, Wi-Fi Direct through NetworkManager, and monitors that no
  longer go black at start on NVIDIA.
- **Signed Windows installers** are supported in the build.

# Get it

## Works with

| Pair | What you get |
|---|---|
| Mac ↔ Windows PC | Every computer feature |
| Mac ↔ Mac | Everything |
| PC ↔ PC | Everything |
| Linux ↔ Mac, PC or Linux | Everything ([a few differences](#linux)) |
| Android ↔ Mac, Windows or Linux | Every phone and tablet feature |

Every pair connects over the same Wi-Fi, Bluetooth, or a direct Wi-Fi link; a phone also over a USB cable.

<p align="center">
  <img src=".github/assets/tour.gif" alt="A tour of the TwinDesk window" width="820">
</p>

## Get started

1. **Download** TwinDesk for each computer and your phone from the [releases](https://github.com/InukaAsith/TwinDesk/releases/latest).
2. **Open it on both.** They find each other on the same network, over Bluetooth, or over a USB cable for a phone.
3. **Pair once** by comparing a code (on a USB cable, just click Allow). From then on they connect by themselves.

For the phone's screen and apps in windows, TwinDesk walks you through turning on Android's
wireless debugging once ([details](#wireless-debugging)). Files, clipboard, notifications, calls,
texts, photos and mouse and keyboard (through Accessibility) work without it.

## Privacy

TwinDesk only talks to devices you've paired with, directly over your own network, Bluetooth, a
direct Wi-Fi link or a cable. There are no accounts, no telemetry and no cloud relay. Your calls,
texts and photos go straight from the phone to your computer and nowhere else. The only internet
request is an update check against GitHub's public releases, which you can turn off.

<br>

---

# Under the hood

Everything below is for the curious and for people building TwinDesk themselves.

## Linux

On Linux, TwinDesk runs on both X11 and Wayland. On Wayland, the mouse and keyboard go through
evdev and uinput (the Setup screen grants access once), and screens are captured through the
desktop portal. A few things work a little differently:

- **Shared folder.** Sharing uses Samba. The first time, one password prompt installs it if it's
  missing and adds a network-only account. The other computer's folder is connected with GVFS
  and shows in the file manager's sidebar.
- **Copy and paste files.** <kbd>Ctrl+Alt+C</kbd> copies what's selected in the file manager in
  front (or files you already copied), and <kbd>Ctrl+Alt+V</kbd> pastes into the file manager
  window in front (else Downloads). Right-click › *Send to* works in Nautilus, Nemo, Caja,
  Dolphin and Thunar.
- **Dragging files across the edge.** Files dragged in from the other computer are dropped into
  the folder under the pointer, or the desktop. On Wayland, they go to the file manager window in
  front. Dragging files out of Linux needs an Xorg session.
- **Extend.** On GNOME (Wayland) it uses Mutter's own virtual monitor; pick "Virtual remote
  monitor" when the desktop asks which screen to share. On X11 it switches on a spare output of
  the graphics driver (not available on NVIDIA's driver). That needs a small helper, which the
  .deb installs; with the AppImage, Share screen › *TwinDesk virtual display* › Install puts it in
  once, with your password.
- **Apps.** Opening this computer's apps on the other side needs an Xorg session.
- **Bluetooth and Wi-Fi Direct.** Bluetooth LE goes through BlueZ, and direct Wi-Fi links through
  NetworkManager, hosted beside the computer's own Wi-Fi where the adapter allows (2.4 GHz groups
  for a phone).
- **Android phone.** Everything in [Android](#android-in-detail) works on Linux too: the phone's screen and
  apps in windows, the mouse and keyboard across the edge, files, clipboard, notifications and
  sound. The package carries adb; the Setup screen's firewall fix opens mDNS (5353/udp) so the
  phone's wireless debugging is found.

## Android in detail

Install TwinDesk on the phone, open it next to TwinDesk on the computer and pair from Overview › Nearby. The phone needs Android 10, and Android 11 for everything that goes through wireless debugging.

### The phone app

The app is laid out like the computers' (a sidebar on tablets, tabs at the bottom on phones), and
every page names the computer it's connected to:

| Page | What it does |
|---|---|
| **Overview** | The computer you're connected to, Connect and Disconnect, nearby computers to pair with, and the wireless debugging card until that's set up |
| **Screen** | Use the phone as a screen for the computer: Mirror, or Extend the desktop onto it. Touch works as the mouse (tap to click, hold to right click, drag to select or move windows, two fingers to scroll), with the computer's sound and Smooth playback |
| **Cursor** | The computer's mouse on the phone across the screen edge, its pointer speed here, reverse scrolling, right and middle click |
| **Keyboard** | The computer's keyboard types on the phone, every key as a key, so any layout works and the soft keyboard stays out of the way. A keyboard on the phone types on the computer |
| **Clipboard** | Copy on one, paste on the other, each way on its own switch, at once or when sent |
| **Notifications** | The phone's notifications on the computer, with the text hidden if you like, and the computer's on the phone |
| **Files** | Send files, copy them to paste on the computer, and see where the computer's files land |
| **Sound** | The phone's sound on the computer, and the computer's sound on the phone |
| **General** | The phone's name, background running, and the permissions TwinDesk uses, each with its switch |
| **About** | Source code, releases, the license, and what goes over wireless debugging and the network |

And outside the app:

- **Share sheet:** *Send to computer* and *Copy to computer* in every app's Share menu.
- **Quick Settings tiles:** *Send clipboard* and *Wireless debugging*.
- **Home screen shortcuts:** the computer's screen, and wireless debugging on in one tap.
- **The ongoing notification** shows what's connected, with Exit.
- **Copied on the computer:** files copied with <kbd>⌃⌥C</kbd> / <kbd>Ctrl+Alt+C</kbd> arrive as a
  notification with Copy (paste them in any app) and Save.
- **The computer can install the full app** over wireless debugging (Phone page › Notifications
  from the phone): Play Protect blocks downloaded apps that read notifications, so the download
  leaves that out and the computer adds it. Settings and pairing stay.

### Wireless debugging

Files, the clipboard and notifications work right away. The phone's screen, its apps in windows,
touch, your mouse and keyboard on the phone and its sound go through **wireless debugging**, which
TwinDesk pairs with once:

<p align="center">
  <img src=".github/assets/ui-phone-pair.jpg" alt="Overview: the wireless debugging card under the connected computers, with the pairing code" width="820">
</p>

- Until it's paired, a card under the connected computers on Overview (on the computer and on the
  phone) walks you through it. Open *Developer options › Wireless debugging › Pair device with
  pairing code* on the phone and type the 6-digit code on the computer, or on the phone in
  TwinDesk's notification (Settings' dialog stays open). The phone sends the code to whichever
  computer it's connected to: Mac, PC or Linux.
- After that TwinDesk switches wireless debugging on by itself when it needs it, follows it to its
  new port every time it restarts, and keeps the pairing from expiring (Android otherwise forgets
  a computer after 7 days unused). Phones that switch it off on every Wi-Fi change or screen lock
  (MIUI, HyperOS) get it switched back on as soon as they're unlocked, or a prompt if they refuse.
  Wireless debugging only runs while **USB debugging** is on too, so TwinDesk turns both on.
- **Xiaomi, Redmi and POCO** also need *Developer options › USB debugging (Security settings)* for
  touch, mouse and keyboard (it asks for a Mi account). Without it the screen shows but input is
  refused; the computer's Phone page says "Touch blocked" until it's on.
- **On a Mac, the phone in Finder.** Turn it on in the Mount tab and click Mount: the phone shows
  under Locations like any server. Until then TwinDesk never looks at the phone's files. It goes
  through the cable when USB debugging is allowed, else over wireless debugging. Finder's `.DS_Store` and `._` files never land on the phone.

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
| `linux-helper/` | Linux helper (C): XInput2 / XTest on X11, evdev / uinput on Wayland, XRandR, window list, XDND edge strip |
| `android/` | Android app (Kotlin, Jetpack Compose); the computers drive the phone through adb and [scrcpy](https://github.com/Genymobile/scrcpy)'s server |
| `shared/` | Used by every app: the wire protocol, the Bluetooth pipe and Wi-Fi Direct links, the phone hub (Calls, Messages, Photos, Phone Files), shared folders, frame generation and icons |

The link between two devices is one TLS session wherever it runs: on the local network, through
a phone's USB cable (adb), or through **Bluetooth LE** (a GATT pipe of TwinDesk's own,
`shared/blepipe.js`). When a session on Bluetooth needs bandwidth, `shared/netlink.js` brings up a
**Wi-Fi Direct** group or joins a phone's hotspot, moves the session onto it, and takes it down
again once nothing needs it. Calls, Messages, Photos and Phone Files are `shared/phonehub.js` on
the computers, answered by TwinDesk on the phone.

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
Monitoring** (once; after that the General tab shows each permission's status).

`npm run dist` signs the app with a certificate of its own, made the first time in
`~/.twindesk-signing` (keep a backup). macOS keeps permissions per signature, so with the same
certificate they carry over when an update is dragged into Applications. An app built without it is
signed ad-hoc, and macOS treats every update as a new app; TwinDesk then clears the stale entries so
Allow works again.

### Windows 10 / 11

```bat
cd windows
npm install
npm run build:helper            :: uses the .NET Framework C# compiler that ships with Windows
npm start
npm run dist                    :: NSIS installer in windows\dist\
npm run dist -- arm64           :: the Windows on ARM installer (or `x64 arm64` for both)
```

`npm run dist` also works on a Mac or Linux: it skips the helper build and packages the
`twindesk-mesh-winhelper.exe` already in `windows-helper\bin\` (for example, one taken from a release).

The installer adds the firewall rules (for every network profile, so a standard account on a
Public network doesn't need an administrator later). The Setup screen, shown once, offers to fix
the firewall if something changed (that needs an administrator) and to install the optional Virtual
Display Driver for Extend.

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
prompt, then log out and back in once). It can also install OpenSSH for the terminal. Extend on
GNOME Wayland uses Python 3 with GObject and GStreamer's PipeWire plugin (`python3-gi`,
`gstreamer1.0-pipewire`), which GNOME desktops already have.


#### Testing the Linux app from a Mac

`linux/scripts/vm-test.sh` runs it in a [Parallels Desktop](https://www.parallels.com) Linux VM
(Ubuntu with the packages above and Node.js): it copies this checkout into the VM, builds the
helper, starts TwinDesk in the VM's desktop session and drives it from the Mac.

```sh
linux/scripts/vm-test.sh start            # sync, build and (re)start it in the VM
linux/scripts/vm-test.sh shot linux.png   # screenshot of its window
linux/scripts/vm-test.sh eval "UI.go('cursor')"
linux/scripts/vm-test.sh log
```

On the VM's shared network it finds the Mac's TwinDesk and pairs like any Linux computer.

### Android

```sh
cd android
./gradlew assembleRelease        # JDK 17+; app/build/outputs/apk/{standard,full}/release/
```

`standard` is the build people download. `full` adds notification access and the SMS permissions
(Messages), which Play Protect blocks in downloaded apps; the computers install it over wireless debugging (Phone page ›
Notifications from the phone), so `npm run dist` on each platform bundles the newest
`android/dist/*-full.apk`.

### GitHub Actions

**Build Android**, **Build Linux** and **Build Windows** (Actions tab › Run workflow) make the
standard and full APKs, the AppImage and .deb, and the x64 and arm64 installers, helpers included.
Set the `ANDROID_KEYSTORE` secret to the key the Android app is signed with
(`base64 -i ~/.android/debug.keystore`): the APKs then install over existing ones, and the Linux and
Windows builds carry the full Android app. Without it the APKs get the runner's own key and the
computers' builds leave the Android app out.

To Authenticode-sign the Windows installers, set the `WIN_CSC_LINK` secret to a base64-encoded
Windows code-signing `.pfx` certificate and `WIN_CSC_KEY_PASSWORD` to its password. Keep the
certificate and password out of the repository. When `WIN_CSC_LINK` is set, the Windows build fails
if signing cannot complete instead of silently publishing an unsigned installer. Signing gives
users a verified publisher and can help SmartScreen reputation build over time; it does not
guarantee that antivirus products will stop flagging a file.

## License

TwinDesk is free software, licensed under the [GNU General Public License v3.0](LICENSE).
Copyright © 2026 inukaasith.

Parts are adapted from [DeskPad](https://github.com/Stengo/DeskPad) (MIT). See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)
for details.
