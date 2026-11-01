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
| Windows | Document | The file in Windows' Recent list whose name the window title shows | Its file comes across (`file.offer` drop `rezume`) and opens |
| Mac | Browser tab | Safari and Chromium browsers through Apple Events (macOS asks once per browser); Firefox from its session file | As above |
| Mac | Document | The front window's `AXDocument` (System Events: asked once) | As above |
| Linux | Browser tab | The address bar through AT-SPI (X11 and Wayland); otherwise Firefox's session or Chromium's history | As above |
| Linux | Document | `recently-used.xbel` matched to the window title | As above |
| Phone | Browser tab | The address bar by its view id (TwinDesk's Accessibility, full app) | Default browser |
| Phone | App | The app in front (Accessibility), or through wireless debugging when Accessibility is off | A phone window (Mirror apps; needs wireless debugging) |

Only `http` and `https` addresses are ever opened. A document's path never leaves the device: only
its name and size do, and the file goes only to a side that asked for it.

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

`rz.policy`, `rz.offer`, `rz.clear`, `rz.take`, `rz.done` (shared/protocol.js). A side offers only
to one whose `rz.policy` says on, so an older app never gets any. Code: `shared/rezume.js` (core),
`shared/rezume-shelf.js` (taskbar and notification), `shared/ui-rezume.js` (tab),
`shared/browsertabs.js`, each platform's `activity.js`, Android's `Rezume.kt`. Test:
`node shared/test/rezume.js`.
