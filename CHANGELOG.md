# Changelog

Everything that changed in TwinDesk, newest first. Each version links to its full release notes,
with pictures, on the [releases page](https://github.com/InukaAsith/TwinDesk/releases).

Update every device you pair. A newer TwinDesk still talks to an older one, and a new feature
switches on only when both sides have it ([how that's decided](docs/capabilities.md)).

Numbers like (#143) are [issues and pull requests](https://github.com/InukaAsith/TwinDesk/issues).
Everyone who sent code, reported a problem or tested is thanked under their version.

## Next (unreleased)

### New

- **Sound › Only on the computer** (Android, on by default): without wireless debugging, the phone's
  speaker goes quiet while its sound plays on the computer, and its volume comes back after.
- **A laptop's battery** on the other computer's page.
- **Waiting to send:** files sent while the other device isn't connected wait for it and go when it
  connects. Files › Keep files to send sets how long (1 hour, 1 day, 1 week, or off). On every
  computer and on Android, phone ↔ computer and computer ↔ computer.
- **Pause and Resume** a Send files batch: the files that hadn't arrived wait under Waiting to send.
  If the connection drops in the middle, the rest goes again by itself when it's back, into the same
  folders.
- **Phone window side rail** (Mac and Linux; Windows' side panel gets the same): Screenshot (copied,
  and saved in Pictures › TwinDesk), Record (the picture and the phone's sound, as MP4 in Movies ›
  TwinDesk; WebM where MP4 can't be made), the volume keys, Rotate, Power and Phone screen off. Its
  button in the title bar shows or hides it; on Windows it switches the side panel.
- **Banking pause, gentler** (Android): debugging comes back on by itself a few minutes after you
  leave the banking app (needs Usage access; Settings › Banking pause › Turn back on after the
  banking app), and its notice has Turn back on. **Open with banking pause** puts a home-screen
  shortcut for a banking app that switches debugging off first, then opens it.
- **Linked with Android** (General): link a computer through Android's own companion device
  chooser, and Android keeps TwinDesk running and connected in the background, with no battery
  optimization prompt. **Start TwinDesk when it's near** (off unless switched on, Android 12+):
  Android watches for the computer over Bluetooth and TwinDesk starts and connects when it shows up.
- **Open, Email and Call** in Clipboard › Recent: a copied link, email address or phone number gets
  a button that opens it in the computer's own app (on every computer, and the phone's page in
  Multi-device).
- **Put received files on the clipboard** (Files, off unless switched on): files sent to this
  computer are ready to paste with ⌘V or Ctrl+V.
- **Take a photo with the phone** (Camera, with an Android phone): the phone's camera opens, and
  the photo comes to the computer already copied, ready to paste into a document or a chat.
- **Voice note** (Android, a notification button to choose in General › Notification buttons):
  records on the phone, and Send puts it on the computer (it waits if the computer isn't
  connected). A copy stays in Recordings › TwinDesk.
- **Local API** (General, off unless switched on; Mac, Windows, Linux): your own scripts on this
  computer can send files and set the clipboard, with a key that changes each start; nothing from
  a browser ([docs/local-api.md](docs/local-api.md)).
- **Live Updates on Android 16:** a file transfer's progress shows on the lock screen and as a chip
  in the status bar, with Pause and Cancel.
- **Deck › OBS Studio:** record, pause, stream, switch scenes, mute a source, save a replay and
  turn on the virtual camera, with the tile showing what OBS is doing. Uses OBS's own WebSocket
  server on the computer.
- **Auto-rotate** on the phone window's side rail and Windows' side panel: an app window turns with
  its app (a video in full screen), the phone's screen with the phone; switch it off to keep the
  window's shape. On Android, the computer's screen and another phone's screen get a side rail too
  (a tab at the right edge): Auto-rotate and Screenshot.
- **iPhone and iPad:** the computer's screen gets Auto-rotate and Screenshot (into Photos) in its bar.

- **Cursor portals** (Mac): a stretch of one display's edge leads to a chosen stretch of the other
  computer's screen, and the pointer comes back through it (#177 by [@pengusto](https://github.com/pengusto)).
- **Share screen › Capture** (Windows): Original (Chromium, the default), Automatic, Desktop
  Duplication or Windows Graphics Capture; the pointer is shared at its real size, an enlarged
  accessibility pointer too (#235 by MOVE).
- **Several networks** (Windows): with a cable and Wi-Fi (or a VPN) on both computers, Found nearby
  lists each network, and a paired computer has a Network menu: Automatic or one of them (#236 by MOVE).
- **Mac with no display** (lid closed, monitor unplugged): screen sharing goes on through a TwinDesk
  virtual display until a real one is back (#219 by [@alexfoxtm](https://github.com/alexfoxtm), #184).

### Fixes

- **Copy code** no longer takes a card's last digits, a price, an account, order or tracking number,
  a date, a phone number or a zip, promo or error code for a one-time code.
- **Phone app windows:** a video in full screen came in landscape into a portrait window, small
  between bars (#258); an app opened on an asleep phone waited for a picture that never came (#247,
  #239), and its window has Phone screen off too.
- **Mac:** Ctrl+Space and Ctrl+Option+Space reach apps on a controlled Mac unless they are its
  input-source shortcut with two or more sources (#241, #243 by [@hughesyadaddy](https://github.com/hughesyadaddy)).
- **Multi-device:** moving the pointer to another computer no longer stops the sound playing to a
  third one, and one computer without cursor sharing no longer blocks the rest (#245, #220, #246 by
  [@icariantk](https://github.com/icariantk)). Move windows sends a window to the computer the pointer went to, also back to the
  one driving this one (#250, #251); Monitor 2 follows a computer that starts sharing (#256).
- **Move windows:** a window brought back returns where it was (Windows Multi-device and Linux,
  #252); the Apps page says when the other computer's Move windows is off (#253), and that Wayland
  can't move windows (#249).
- **Extend to a Linux or Windows viewer** is the viewer's size and shape, portrait too, instead of
  1920 × 1080 (#254), and Monitor 2 takes the shape of what it shows (#255).
- **Linux:** the phone's Media page shows what plays without playerctl (MPRIS over D-Bus, #242); on
  COSMIC the pointer from another computer reaches every monitor (#244); Bluetooth that BlueZ
  refused once is tried again instead of staying off until a restart.
- **Android clipboard:** on a phone whose copies didn't reach the computer in the background
  (Android 17), they do now (#257). A Pixel on the USB cable is no longer asked again and again to
  turn on wireless debugging (#239).
- **Phone windows** no longer wait for the picture for good when the computer's video decoder fails
  on the phone's stream: they switch to software decoding (#233).
- **Several phones on adb:** one phone's address no longer matches another's that starts the same
  (192.168.8.17 and 192.168.8.175), so screens, apps and the camera come from the right phone (#239).
- **Photos › Save and Files › Save** from a phone (Windows, Linux): the files are taken even with
  Take files from {name} off, since they were asked for; they stayed at 0% (#239).
- **Photos › Save and Files › Save** from a phone (Mac): the files are taken even with Accept files
  off, since this computer asked for them on that connection; they stayed at 0% (#239).
- **The log** can't fill the disk: a line repeated in a loop is written once and counted, and a
  packaged Linux app started from the menu no longer copies everything to the desktop's own log (#239).
- **Linux on Wayland** (Hyprland, niri): the log says why a push against the screen's edge didn't cross (#237).
- **Windows:** a key held while the pointer comes home no longer stays down (#248); the pointer
  coming home always gets its cursors back (#238).
- **Android 15 and later:** one-time codes reach Copy code (the phone setup over wireless debugging
  lets TwinDesk read the codes Android hides).
- **Passwords copied on an Android phone** (marked sensitive by the password manager) stay on the
  phone, as the computers' already did.
- **Idle sessions use less:** a computer no longer reads its volume, Bluetooth and Do not disturb
  every minute for the whole session (two PowerShell runs a minute on Windows), only while the
  other computer shows them; and no `adb` process every 2 seconds while a phone is linked.
- A phone on wireless debugging found by name (`adb-…(2)._adb-tls-connect`) kept its state, and
  Mount no longer took it for a phone on the USB cable.

### Fixed

- Phone app windows open and resize to a phone-like size (a multiple of 16, no shape past 22:9):
  some apps, a phone maker's Camera among them, stopped on odd sizes.

## 3.2.1 (unreleased)

Ideas from [@rahulpatel902](https://github.com/rahulpatel902)'s list of suggestions (#231), in
TwinDesk's own look.

### New

- **TwinDesk pop-ups** (Notifications › Showing here › Pop-ups): a phone's notifications in
  TwinDesk's own small window, if you pick it. Reply is typed right in it, the app's own buttons
  (Mark as read, Mute…) are there, a picture shows when the notification has one, a one-time code
  has Copy, and a download or a timer fills its bar in place instead of a new notification each time.
  The system's notifications stay the default everywhere, as the lightest: with them the phone
  sends no pictures or progress.
- **Buttons on Linux's own notifications:** the phone app's buttons and a one-time code's Copy, as
  on a Mac (through notify-send 0.7.9 or later; without it, the plain notification as before).
- **Each app its own way:** Show, No pop-ups (only in Recent) or Hide for each phone app.
- **Pause pop-ups on a schedule:** from one time to another, overnight too. Notifications still go
  in Recent and Messages.
- **Copy codes by themselves:** a one-time code goes on the clipboard when it arrives, never to the
  other devices or the clipboard history, and off the clipboard after 2 minutes.
- **Messages:** contact and chat pictures with the app's badge, a search box over the chats and the
  texts, Delete for a chat or a text thread (here only), and Apps… to choose which chat apps show.
  Progress notifications ("Sending video…", "Deleting…") no longer turn into chats.
- **Photos:** the phone's albums in a sidebar, with their covers and counts. Open, and on Windows
  Open with…, for the photo in the viewer.
- **The media card** stays compact: its chevron slides open back and forward 10 s, the phone's
  volume and where the sound plays. Its colour can follow the artwork (General).
- **Calls pause the music** (Calls › Sound, off by default): a call ringing or under way pauses what
  plays on this computer, and the end of the call plays it again, only if it was the call that
  paused it.
- **Camera:** Mirror (here, in its window and in the virtual camera), Quality from 720p to 4K, the
  light, zoom in and out, and Snapshot for the picture as it shows.
- **Keep on top:** a pin in the toolbar of the phone's screen, the phone's camera and a computer's
  shared screen keeps that window over the others.
- **Skip adbd** (Mirroring, off unless you switch it on): over Wi-Fi the phone's screen, sound and input go straight to
  this computer, encrypted, instead of through wireless debugging's adbd and adb server. Its
  biggest gain is while adb is busy: with a big file going to the phone, a tap showed up in about
  90 ms instead of 210 ms (400 ms at the slow end). If the phone can't be reached directly, it goes
  through wireless debugging as before. Over USB nothing changes.
- **Low latency** (Mirroring, off): asks the phone's video encoder to send each frame as soon as
  it's ready. Some phones ignore it.

### Fixes

- Multi-device on a Mac: the Camera page's picture showed a broken image (the page didn't allow
  it to load).

### Thanks

- [@rahulpatel902](https://github.com/rahulpatel902) for the suggestions in #231.

## [3.2.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v3.2.0) (2026-11-14)

The first release since 3.0.0: what was going to be 3.1.1, and everything under 3.1.0 below, which
was never released on its own.

### New

- **Hold a key to cross** (#230): pick Command (Win, Super), Control, Alt or Shift on the Mouse page,
  and the pointer leaves this computer at its edge only while it's held. One-to-one, the way back
  needs it too when the other computer has 3.2. In Multi-device it's for this computer's own mouse
  or trackpad at its edges. Mac, Windows and Linux (X11 and Wayland). Thanks
  [@pengusto](https://github.com/pengusto).
- **Emergency return** (#178): a shortcut (Control+Alt+Command+Esc by default, Win or Super for
  Command, or your own, in Mouse) that stops sharing at once: the helper lets go first, then the
  mouse and keyboard come home and sharing turns off. Nothing the other computer sends gets in until
  then. Mac, Windows and Linux, one-to-one and Multi-device. Thanks
  [@pengusto](https://github.com/pengusto).
- **The tour in Multi-device:** someone new to TwinDesk gets the same tour in Multi-device as in
  one-to-one (how to install TwinDesk on the other device, pair it, and what each page does), with a
  last stop on the Multi-device page. After an update, What's new shows there too. Both are in
  General › Tutorial.
- **Every edition on one release:** the installers, TwinDesk Portable and the Full KVM builds
  (Windows and Linux) are all on the 3.2.0 release. The updater takes your own edition's file: Full
  KVM updates to Full KVM, Portable to Portable, and the normal app never to either.
- **What's new for 3.2:** the list after updating covers everything since 3.0, including TwinDesk
  Drive, the monitor map and the touchpad gestures.
- **TwinDesk Drive** (File Sharing): one folder kept the same on your computers, with no cloud.
  Each keeps its own copy and works offline; they swap what changed when they connect. A file
  changed on two at once keeps both, one as "(conflict from …)", and deleted files go to the Trash
  or Recycle Bin. Off until you turn it on, and nothing of it runs until then
  ([how it works](docs/drive.md)). Mac, Windows and Linux, one-to-one and Multi-device: in
  Multi-device every connected computer syncs, and a change passes on to the ones it didn't reach.
- **Multi-device catches up with one-to-one:** ReZume with any one device of the mesh, picked on the
  ReZume page and the same on both (picking a computer picks this one there; the one either was
  with before lets go). Mouse and keyboard over Bluetooth between Macs and Windows PCs. Pages that are
  switched off in General › Modules aren't loaded, and their tray menus go. The Connection page has the
  full wireless debugging card, and Windows and Linux open in the right Style.
- **The monitor map in Multi-device** (#225): every device's monitors in one picture, arranged by
  dragging. The pointer crosses only where monitors touch, keeps its place along the edge, and goes
  through an offline device to the next one. Phones hang off a computer's edge, and red shows where
  an offline computer stops the pointer.
- **Linux touchpad driving another device** (#222): tap to click with one, two or three fingers,
  two-finger scrolling and pinch, read from the desktop's own settings (GNOME, KDE, Hyprland, Sway,
  niri). A pinch reaches an Android phone as two fingers.
- **Pick which Mac display an Android phone mirrors** (#221), from the Screen page or the viewer's
  toolbar. One-to-one only; if that monitor goes, another one is shown.
- **A custom size for Extend** (Windows, #226): any width and height from 320 to 7680, and a
  Resolution that follows it, so the other side gets exactly the extra screen.
- **Overview cards end level** (#224): cards side by side are as tall as each other.
- **The Full KVM page in every build** (Windows, Linux): with its own icon and an animation of it at
  work. The normal build shows what it does and says it's only in the Full KVM builds; none of Full
  KVM's service or helpers are in it. Full KVM is also a module now (General › Modules).
- **TwinDesk Portable** (Windows): one .exe that runs without installing. Run normally it does
  everything that needs no administrator (PORTABLE · LIMITED beside the name); run as administrator,
  also the firewall, folder sharing, Wake on LAN and SSH keys of administrators (PORTABLE · FULL).
  Drivers, OpenSSH Server, the calls' sound and Full KVM need the installed TwinDesk. General ›
  Portable says which is which.

### Fixes

- **Arrange looks like Search:** the sidebar's Arrange popup has the same deeper dim and solid panel
  as Search instead of a blur over the window, in one-to-one and Multi-device.
- **Full KVM at the login screen** (Windows): after signing out, a computer connected but the pointer
  didn't move. The service never told the machine node its helper was ready.
- **Full KVM at the login screen after pairing again** (Windows): a computer paired again (or a
  device forgotten, or the map changed) while signed in couldn't connect after signing out: the login
  screen still had the pairings from when System-wide was turned on, and one the other side refused
  was forgotten there for good. The service now takes them again from your TwinDesk at each sign-out,
  and the login screen never forgets a pairing itself.
- **Coming back to a PC with two monitors** (mesh and one-to-one): with a MacBook under the main
  monitor, the pointer could come back on the second monitor, or in the middle of the screen after a
  fast move. It now comes back on the edge that touches the device it left, where it left.
- **Full KVM** stays at the bottom of the sidebar with Multi-device, General and About; Arrange
  doesn't move it.
- **General's Portable** showed in the list beside the page on an installed TwinDesk, which has no
  Portable card. A card that's hidden has no link there now.
- **Clipboard:** copying the same text again after the other side copied something sends it again
  (#223), on the computers and now on Android and iPhone too (#227).
- **Pinch on Android** from a Mac trackpad or a Linux touchpad (#228): pinching in did nothing,
  because the two fingers started closer than Android needs to see a pinch. They now start far
  enough apart, a long pinch keeps zooming, and it works without wireless debugging too.
- **Phone keyboard layout in Multi-device:** the Phone page on Linux and Windows now has **Type as
  a hardware keyboard**, so an AZERTY or other layout reaches an Android phone as it is (#188).

### Thanks

Code from [@alexfoxtm](https://github.com/alexfoxtm) (#221, #227, #228),
[@youyouhdhd](https://github.com/youyouhdhd) (#226) and [@pengusto](https://github.com/pengusto) (#178, #230).
Reported by [@ElMahaster](https://github.com/ElMahaster) (#188).

## 3.1.0 (not released: in 3.2.0)

### New

- **Deck.** A Stream Deck style grid of buttons on the phone (Android, iPhone, Web) for the computer:
  spaces and pages, tiles of any size, live sliders for sound and brightness, Bluetooth devices, the
  sound output and microphone, files and saved scripts opened like a double-click (never through a
  shell), and a full-screen mode with widgets.
- **The window space on the Deck.** The computer's windows on the phone: tap an app, pick a layout,
  and they're arranged. Save a few apps as a set on the shelf and arrange them again with one tap.
  Snap, minimize, maximize and close from the phone.
- **Air mouse and Presentation** in Remote on Android, iPhone and Web: point the phone to move the
  pointer, hold Left click to drag, and a laser pointer for slides. A three-finger tap on the
  touchpad is a middle click.
- **Search everywhere** (⌘K, Ctrl+K on Windows and Linux, or the search button): settings, shortcuts
  and features found by what they do.
- **Arrange** the sidebar and the phone's bottom bar, and **General › Modules**: every page but
  General, About, Connection and Overview can be switched off, and a module that's off isn't loaded.
- **Clipboard and notification history kept across restarts**, encrypted, when you ask: for a day,
  a week, 30 days or a year. On the phones too, in their own views.
- **Updates install in place.** The Mac swaps in the new app and keeps its permissions, Windows runs
  the installer silently, Android installs the APK over itself, and TwinDesk on an iPhone is
  re-signed by the computer.
- **TwinDesk iPhone** (opt in, off by default): the computer signs TwinDesk for iPhone with your own
  free Apple ID, installs it over the cable or Wi-Fi and refreshes it before it expires.
- **A tour for someone new** on Mac, Windows and Linux: what TwinDesk is for, how to install it on
  the other device (with a QR code for a phone), and a demo device that lights up the real pages.
- **Phone-to-phone sound**: low-latency audio between two Android phones over UDP (#205).
- **Photos**: Copy and Share in the viewer.
- **Overview shortcuts** in as many rows as you want, one to eight.

### Multi-device (Mesh) out of beta

- Fast files (fx and fx2) per session, as in the one-to-one app, phones included.
- The Camera, Remote, Deck, ReZume (with one phone alone), TwinDesk iPhone and Modules pages.
- Every device's notifications with their buttons, Reply and a Copy button for one-time codes.
- Clipboard pictures and screenshots to every device that takes them.
- Now Playing both ways for every phone, and the phone's sound over Bluetooth on Windows and Linux.
- Pair a phone with a QR code, and wireless debugging's Pair with QR code for the active phone.
- Pairing gives up with a reason, says which side to update on a version mismatch, and names once
  what a device with an older TwinDesk lacks.

### Installing

- **APT repository** for Debian, Ubuntu, Mint and Pop!_OS, updated by `apt upgrade`.
- **winget**: each release is sent to winget-pkgs by itself (the first listing is in review).
- **F-Droid** build and recipe (the full app without Google's code scanner and without the updater).
- **Microsoft Store** MSIX build, ready for the Store listing.
- **AltStore and SideStore** install the 3.0.0 IPA again (#229).

### Fixes

- Android reconnects to its computer after a long Wi-Fi interruption (#192, #217).
- Android settings and notification settings refresh at once (#190, #191, #214).
- Mac: the screen capture names its display and size (#198, #199), General asks for a missing
  screen permission (#200, #201), and the screen viewer fits the Android window (#215).
- Mac: a Universal Clipboard item no longer delays pasting (#211).
- Windows: right Shift from keyboards that flag it as extended is no longer lost (#212), and a click
  on TwinDesk's own minimize, maximize or close buttons from the other computer no longer freezes
  the session (#203, #208, #209).
- Windows: dragging and pasting files no longer writes zeros from fast files.
- Windows Multi-device starts without the helper when Windows blocks it (#216).
- Multi-device: sound stays on its device when the selection moves (#194, #196), and per-pair
  switches stay in step when another device is selected (#193, #195).
- Linux: Open at login works under systemd's autostart generator (#189, #202).
- Nix: starts with its window and tray again (#213).

### Thanks

Code from [@alexfoxtm](https://github.com/alexfoxtm) (#190, #199, #201, #214, #215, #217),
[@hughesyadaddy](https://github.com/hughesyadaddy) (#195, #196),
[@ShivanshuKantPrasad](https://github.com/ShivanshuKantPrasad) (#205, #213),
[@Yashkush06](https://github.com/Yashkush06) (#197) and
[@YashvanthSankar](https://github.com/YashvanthSankar) (#202).

## [3.0.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v3.0.0) (2026-11-09)

Now on iPhone, iPad and any browser.

### New

- **TwinDesk for iPhone and iPad**, a native SwiftUI app: the computer's screen on the iPhone
  (mirrored or as a second display) with touch, touchpad mode and the Apple Pencil as a pen; Share
  Screen; files both ways on fx2; Photos on the computer; clipboard, notifications, sound, camera
  and microphone; Remote and Media; Shortcuts and Back Tap. Pairs over Wi-Fi, USB or Bluetooth.
- **TwinDesk Web**: type `twindesk.local` in any browser on the network and pair once. The
  computer's screen, files, clipboard, notifications (Web Push sent by the computer itself, no
  server), Remote, camera and microphone. Add to Home Screen and it runs like an app.
- **Phone to phone**: Android to Android, iPhone to iPhone and Android to iPhone, with clipboard,
  notifications, files, photos, messages and screens.
- **Glass look** (General › Appearance › Style).
- **Receive AirPlay on Windows and Linux**, with sound.
- **Tailscale** (#161): away from home, devices reach each other over your tailnet.
- **Mouse and keyboard over Bluetooth** for crowded Wi-Fi (#158, off by default).
- **The phone keyboard as a real USB keyboard** (#123, off by default).
- **Pens in screen viewers**, real multitouch on Windows, 4K, Playback › Steady and a frame-rate cap.
- **Now Playing on a Mac** for the phone.
- **KDE Plasma on Wayland**: the Screen page shows how to extend with krfb-virtualmonitor (#69).
- **Five languages on every app**: English, Simplified Chinese, Russian, Turkish and Brazilian
  Portuguese (#156).
- **Idle links go quiet** (#143), so phones and laptops can sleep.

### Security (#154)

- Pairing locks out an address after 5 failed attempts in 10 minutes, on computers and phones. A QR
  link pairs only once.
- At most 16 unauthenticated sockets per address. Forget ends a pairing still in progress.
- Android's wireless-debugging shortcut can't be triggered by other apps. Windows downloads are
  pinned by SHA-256.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability.

### Fixes

- A copy/paste shortcut or lock key no longer freezes input after a fall back to Bluetooth.
- Linux: Open at login no longer feeds a crash loop through a dead terminal pipe (#172).
- Snapping irregular display groups (#174), and permission resets that targeted another app (#173).

### Thanks

Brazilian Portuguese by Jairo Abreu ([@jairo-ab](https://github.com/jairo-ab), #156).

## [2.5.3](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.5.3) (2026-11-05)

Hot patches on 2.5.0 (2.5.1 to 2.5.3).

- Big single files no longer stop after about 5 minutes, and files over 4 GiB work (#143).
- Faster files with the phone: the direct HTTPS stream instead of base64 on the session (#143).
- New: **Files › Encrypt file transfers** (on by default).
- Linux: mouse sharing works again on distros with glibc older than 2.32 (#149).
- Linux: input access is TwinDesk's helper's alone, never the `input` group (#144).
- Multi-device: the General page is no longer blank (#142).

## [2.5.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.5.3) (2026-11-05)

ReZume, an all-new look, and a new engine underneath.

### New

- **ReZume**: carry the web page, the video (at the same second), the document (Preview, Edit live
  or the app's Window) or the app's windows to the other device. Off until you turn it on.
- **A new look** on every app, light, dark or system, with your own accent color. Devices in the
  sidebar, a new Overview, two-way features as one card per direction.
- **tdv2**: mouse and keyboard on an encrypted UDP lane, in Rust (`tdfast`) inside the native
  helpers, with no allocation per move and a fallback to TCP ([details](docs/protocol.md)).
- **fx2**: files in their own process, parallel ranges, hashed while they stream.
- **Move windows** across the edge with Right Ctrl (Right Command on a Mac).
- **Microphone sharing** between computers, and the phone as a microphone.
- **H.265** screen sharing, a hardware encoder switch on Windows, and the Mac's screen sound on 14.2+.
- Media, volume and brightness keys, Caps Lock that follows you (#131), shake to find the pointer.
- Phone: Full (ADB) or Limited control, install APKs from the computer, notifications per app,
  remove photos.
- **Русский, Türkçe and 简体中文** on the computers.

### Security

- Pairing lockout on every platform (#136). The Windows identity passphrase is sealed with DPAPI
  (#137). Electron 44.

### Fixes

- A busy Wi-Fi no longer drops the session: 8 seconds of silence, not 4 (#74).
- Connect by address no longer leaves the window waiting (#73).
- The cursor no longer jumps to the middle when it comes back to Windows (#121).
- Ethernet shows as Ethernet (#140). Two PCs no longer echo audio settings (#83).

### Thanks

Testing by [@sitharapunchihewa](https://github.com/sitharapunchihewa). Code from
[@ari7hkm](https://github.com/ari7hkm) (#138, #139), [@hughesyadaddy](https://github.com/hughesyadaddy) (#129),
[@Ahmedcodedk](https://github.com/Ahmedcodedk) (#113, #120), [@cashflowbeatz](https://github.com/cashflowbeatz) (#117),
[@Southertly](https://github.com/Southertly) (#106–#110), [@GlazeCookie](https://github.com/GlazeCookie) (#95),
[@iiiiiuri](https://github.com/iiiiiuri) (#85), [@atse25029-collab](https://github.com/atse25029-collab) (#82),
[@VighneshKunjir](https://github.com/VighneshKunjir) (#78–#80), [@AmriteshKhare](https://github.com/AmriteshKhare) (#76)
and [@jayden99236](https://github.com/jayden99236) (#71).

## [2.4.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.4.0) (2026-10-28)

### New

- **Any keyboard language**: Russian, Arabic, Hindi, Sinhala, Thai and more type correctly, and
  Chinese, Japanese and Korean input methods switch over with you (#10).
- **Phone stylus as a pen** with pressure, tilt and the eraser.
- **Crossing map**: both computers' monitors on the Cursor tab, and the pointer crosses only where
  they meet.
- 1000 Hz mice stay smooth, a new file transfer protocol, and Open Log Folder in the tray.
- The in-app updater with release notes (#61).

### Fixes

- Phone touch and gesture navigation no longer lock after the pointer visited the phone (#67).
- Quick flicks no longer cross by accident (#66). File drags no longer stick at the edge.
- Shortcuts and accent keys across keyboard layouts (#10). Remote input wakes a sleeping screen.

### Thanks

The updater by [@benzntech](https://github.com/benzntech) (#61).

## [2.3.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.3.0) (2026-10-26)

- **Camera sharing**: the phone's or the other computer's camera, and a virtual camera
  ("TwinDesk Camera") for Zoom, Teams and Meet on Windows, Mac and Linux (#35).
- **The phone as a remote and a gamepad**, a real controller on Windows and Linux, and a Bluetooth
  gamepad for any computer.
- **Pictures on the clipboard** up to 10 MB, screenshots straight away, and Ctrl+Alt+V pastes files
  into apps.
- WhatsApp, Instagram and Telegram replies press the app's own Send button.
- **Cursor lock** with Scroll Lock (F14 on a Mac).
- What's playing on the phone, on Overview.
- Intel Macs (#52), a NixOS flake and module (#21), a received files folder (#47).
- 40% less memory, modules load lazily, every feature off on a fresh install.

## [2.2.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.2.0) (2026-10-23)

- **Multi-device (Mesh, beta)**: many computers and phones at once, one clipboard, one notification
  pool and one screen layout where each edge leads to a different device (#26, #27, #28).
- Every feature introduces itself until you turn it on.
- Android: Play Protect no longer blocks the downloaded app (#20).

### Thanks

Multi-device is built on the mesh by Erdoğan Yeşil ([@erdodo](https://github.com/erdodo), #29).
Ideas from [@benzntech](https://github.com/benzntech) (#26, #27, #28).

## [2.1.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.1.0) (2026-10-21)

- **No shared Wi-Fi needed**: Bluetooth LE, Wi-Fi Direct, the phone's hotspot and the USB cable (#7).
- **The phone on the computer**: calls, messages, photos, the phone's storage, shared folders both
  ways, the phone as a drive on Windows and Linux.
- Live file progress, Disconnect, Switch and Take over.

### Fixes

- Windows: mouse sharing keeps working from the tray (#16), the cursor stays after a UAC prompt
  (#15), scrolling no longer leaks into background apps (#17), Extend on ARM says why it can't (#14).

### Thanks

[@benzntech](https://github.com/benzntech) (#15, #16, #17), [@NacreousDawn596](https://github.com/NacreousDawn596) (#7),
[@IzzulZain11](https://github.com/IzzulZain11) (#14), [@hensamuel](https://github.com/hensamuel) (#6),
[@dt-memyrlabs](https://github.com/dt-memyrlabs) (#12), [@ColdMan023](https://github.com/ColdMan023) (#10, #11),
and code from [@Jay-Prajapati01](https://github.com/Jay-Prajapati01) (#13) and [@erdodo](https://github.com/erdodo) (#8, #9).

## [2.0.1](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.0.1) (2026-10-19)

- Linux no longer crashes on start with `EADDRINUSE` (#5), and a port that's really taken is named.
- Windows: the installer's PowerShell setup no longer matches an antivirus heuristic (#12).

## [2.0.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v2.0.0) (2026-10-18)

- **Android**: the tablet as a second screen, phone apps in windows, mirroring, file sharing,
  clipboard, notifications and sound, and Mount on the Mac.
- Every feature missing on Linux, and Windows on ARM.

## [0.2.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v0.2.0) (2026-10-16)

- An About page with the version, an update check and system info.

## [0.1.0](https://github.com/InukaAsith/TwinDesk/releases/tag/v0.1.0) (2026-10-14)

The first public beta: a Mac, Windows PC or Linux machine on the same network as one desk. Second
screen (Extend or Mirror), one mouse and keyboard with gestures, the clipboard both ways, files and
folders, the other computer's apps in windows, notifications, a terminal (`ssh twindesk`) and sound.
