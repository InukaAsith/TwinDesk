# ReZume

Go on with what you were doing on the other device: the browser tab, the document, or the phone app
in use there. It works between two computers (Mac, Windows, Linux) and between a computer and a
phone, one-to-one (Multi-device doesn't have it yet).

Off until it's turned on (the ReZume tab on a computer, the ReZume page on the phone). Until then
nothing is read and no permission is asked. It's one switch for the pair: turned on or off on either
side, the other follows while they're connected (`pair.sync`, key `rezume`).

## What goes

| From | What | How it's read | Opens on the other side |
|---|---|---|---|
| Windows | Browser tab | The address bar, through UI Automation (helper `frontActivity`, `Activity.cs`); otherwise the browser's own files | Default browser, or the phone (the app the link belongs to) |
| Windows | Document | The file in Windows' Recent list whose name the window title shows; else the app's command line, PotPlayer's own memory (registry, .ini, playlists), VLC's list, or a file of that name next to Recent's newest (Photos' next picture). Store apps (Photos, Media Player) by the app inside their frame | Its file comes across (`file.offer` drop `rezume`) and opens |
| Mac | Browser tab | Safari and Chromium browsers through Apple Events (macOS asks once per browser); Firefox from its session file | As above |
| Mac | Document | The front window's `AXDocument` (System Events: asked once); an app without one (VLC, IINA) that names a picture, video or PDF in its title: Spotlight's most lately used file of that name | As above |
| Linux | Browser tab | The address bar through AT-SPI (X11 and Wayland); otherwise Firefox's session or Chromium's history | As above |
| Linux | Document | `recently-used.xbel` and KDE's `RecentDocuments` matched to the window title; else VLC's list, or a file of that name next to the recent ones | As above |
| Phone | Browser tab | The address bar by its view id (TwinDesk's Accessibility, full app) | Default browser |
| Phone | App | The app in front (Accessibility), or through wireless debugging when Accessibility is off | A phone window (Mirror apps; needs wireless debugging) |
| Computer | App window | The app in front when it shows no web page or document (off by default: ReZume › App windows, on both computers) | Its windows, streamed one by one as the Apps tab's are |

A browser tab showing a local file (`file:///…`, a PDF in Edge, Chrome, Firefox or Safari) is offered as that document, never as a link (`shared/docfind.js`, which also reads VLC's list and finds a folder's next file). Only `http` and `https` addresses are ever opened. A browser always sends its tab's link, never its
window; a video (YouTube, Vimeo, Twitch, Dailymotion, a video file) opens at the second it was at
(Windows and Linux: the system's media controls; Mac: the browser, where it allows JavaScript from
Apple Events). A document's path never leaves the device: only its name and size do, and the file
goes only to a side that asked for it.

## Documents: Preview, Edit or Window

- **Preview** (the default): a copy, kept in the cache folder (`TwinDesk ReZume` in the system's
  temporary folder) and removed when TwinDesk quits.
- **Edit** (ReZume › Edit documents in place, on both computers): the file itself is shared for
  the session (`shared/rzlive.js`): WebDAV over TLS with the session's certificate, which the other
  computer pins from the session, and a secret token in the path. Only that file and the files the
  app makes next to it while it saves (Word's lock file and temporary copy) can be listed, read or
  written. The other computer mounts it as it mounts the phone drive (Finder, a drive letter
  through WebClient, GVFS) and opens it there; saving saves the original. Unmounted when the
  session ends or TwinDesk quits.
- **Window**: the app's own window, when App windows is on and the app is allowed.

When more than one way is possible and the window is one of them, a chooser asks in the middle of
the screen (`shared/rzpick.js`: Preview, Edit, Window; keys 1–3, Escape cancels). With only Preview
and Edit, Edit is used without asking.

## Allowlists

ReZume › Windows from these apps / Documents from these apps: every app found so far (the first
time its window could go, or one of its documents was offered), with a switch, how often it was
sent and when, and Remove. Allow newly found apps (on by default) decides whether a new app starts
allowed; off, it's listed but blocked until it's switched on. Kept in the settings (`windowApps`,
`fileApps`).

## App windows

The windows of the app are streamed the way the Apps tab streams them (`papp.*` and `rtc2` kind
`window`: `windows/pcapps.js`, `linux/pcapps.js` (X11 only), `mac/appsend.js`), independent of the
Apps tab's own switch. Closing the copy on the other computer only stops that copy. On a Mac, the
streamed windows wait on TwinDesk's virtual display (created for them while screen sharing is off),
where the other computer's clicks still reach them; with the virtual display turned off they go
past the right edge of the screens, where only the keyboard reaches them. They come back to the
main display when streaming stops. Mac apps opened from a PC's or Linux computer's Apps tab go the
same way, window by window, instead of over the shared display.

## Where it shows

On a computer, each one can be switched on or off (ReZume › Where it shows):

- **Taskbar / Dock**: a button with the app's icon ("Continue … from Pixel"). Click it to go on.
  Windows and Linux: a small window of its own, minimized. Mac: a Dock icon (`mac/dockstub.js`).
- **Tray / menu bar**: Continue …, and Send … to (opens what was last in front here on the other side now).
- **Notification**: off by default (every tab switch on the other device would bring one up).
- **Apps tab and Phone page**: the same card as on the ReZume tab.

On the phone: a quiet notification (replaced by the next), the ReZume page, and **Open on computer**
in the share sheet (there only while ReZume is on). Something sent with Send to opens at once when
TwinDesk may show over other apps; otherwise its notification rings once.

## Protocol

`rz.policy` (with `windows`, `live`), `rz.offer` (kind `window`; a document's `live` and `window`),
`rz.clear`, `rz.take` (`how`: `copy`, `live`, `window`), `rz.done` (`live`: where the shared file
is) (shared/protocol.js). A side offers only
to one whose `rz.policy` says on, so an older app never gets any. Code: `shared/rezume.js` (core),
`shared/rezume-shelf.js` (taskbar and notification), `shared/ui-rezume.js` (tab),
`shared/browsertabs.js`, each platform's `activity.js`, Android's `Rezume.kt`. Live documents: `shared/rzlive.js`; the chooser: `shared/rzpick.js`. Tests:
`node shared/test/rezume.js`, `node shared/test/rzlive.js`, `node shared/test/docfind.js`.
