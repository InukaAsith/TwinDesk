# TwinDesk Drive

One folder kept the same on every device that turns it on, like a cloud drive with no cloud. Each
device keeps a full copy, so it works offline. When two devices meet in a session, they swap what
changed since they last met.

It's in **File Sharing › TwinDesk Drive** on the Mac, Windows and Linux, in one-to-one mode and in
Multi-device. The folder is `~/TwinDesk Drive` unless you choose another one.

## Off means off

The app loads `shared/drive-host.js` only once the switch is on. That file in turn loads the engine
(`shared/drive.js`) and the session link (`shared/drive-link.js`). With Drive off there's no
watcher, no timer, no index in memory and no messages. The only cost is a falsy check in the
session server's request handler. An app that has Drive off, or an older app without Drive, never
says `drive.hello`, so the other side never starts.

## How it decides

Each file has an entry in the index: `{p, s, m, h, d, v, by}`.

| Field | Meaning |
|---|---|
| `p` | Path in the folder, `/`-separated, in NFC |
| `s` | Size |
| `m` | Modification time (ms) |
| `h` | SHA-256 (`''` when deleted) |
| `d` | Deleted |
| `v` | Version vector, `{deviceId: n}` |
| `by` | The device that last changed it |

`v` is a version vector: each device counts its own changes to the file. To compare two:

- **One is newer** (every count ≥, at least one >): take the newer one.
- **The same:** nothing to do.
- **Neither** (both changed it since they last agreed): a conflict. Every device picks the same
  winner: the later mtime, then the larger device id. The losing side first keeps its own copy as
  `name (conflict from Device YYYY-MM-DD HHMM).ext`, so nothing is lost. A deletion never wins
  against an edit.

Deleted files stay in the index as tombstones, so the deletion reaches devices that were away. They
go to the Trash or Recycle Bin, never straight to deletion, and only when the file on disk is still
the version that was seen. The same applies to the old version of an edited file.

Each device sends on every change it adopts, so a change reaches a device that only ever meets a
device in the middle (A meets B, later B meets C).

## Scanning

- Recursive `fs.watch`, debounced 1.5 s, plus a full scan every 60 s.
- A file written in the last 2 s is still being written, so it's looked at again later.
- A file whose size and mtime match the index isn't hashed again.
- Never synced: `.twindesk/`, `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, `Icon\r`, Office and
  LibreOffice lock files (`~$*`, `.~lock.*#`), unfinished downloads (`.crdownload`, `.part`,
  `.partial`, `.download`), and the system folders of removable drives.
- Up to 100,000 files, 32 folders deep, paths up to 1,024 characters.
- Names Windows can't hold (`a:b.txt`, `con.txt`, a trailing dot or space) are skipped on Windows
  and stay on the devices that can hold them. The card counts them. A skip never comes back as a
  deletion.
- On the Mac and Windows, two names that differ only in case can't both exist, so the second one
  is skipped there the same way.

One queue (`_run`) handles every change, so a scan, a merge and a download never race. A file still
downloading isn't taken for a deletion by a scan meanwhile.

## On the session

Messages (`shared/protocol.js`). An app without Drive ignores them:

| Message | Direction | Body |
|---|---|---|
| `drive.hello` | either | `{v: 1, again?}`: Drive is on here. Each side answers once with its own. `again`: send everything once more. |
| `drive.index` | either | `{entries, last}`: everything this side has, in parts of 1,000, once both said hello |
| `drive.update` | either | `{entries}`: what changed here since |
| `drive.want` | host → guest | `{id, p, h}`: PUT this version of this file to me |
| `drive.gone` | guest → host | `{id}`: I don't have that version any more |

The bytes go over HTTPS on the session's port, the way fast files do (`shared/fastfile.js`).
Only the host serves:

- The guest `GET`s `/twindesk/drive/f?p=…&h=…` for what it downloads.
- The guest `PUT`s `/twindesk/drive/u?id=…` for what the host asked for in `drive.want`.
- The guest pins the host's certificate (the paired fingerprint) before it sends anything,
  including the token.
- Every request carries the session's fast-files token in `x-twindesk-drive`. The host checks the
  token, that the request comes from the session's address, and that the other side said hello.
- The server only serves a path that's in the index, at the hash asked for, and only if that's what
  is on disk now.

Up to 4 files move at once. A download goes to `.twindesk/` inside the Drive folder, is checked
against its hash, and is renamed into place only if the file there didn't change meanwhile. A
failed download is tried again with the next index (a `drive.hello` with `again` after 30 s).

Never over Bluetooth. A session on Bluetooth waits, and when it moves to Wi-Fi or a cable, the link
kicks (`again`) and everything that waited goes.

## Multi-device

One engine and one index, and a link (`shared/drive-link.js`) to each connected computer, made when
it comes up and dropped when it goes (`createMesh` in `shared/drive-host.js`, on the hub's bus).
Phones never get one. Each link is the session's: guest or host, its own fast-files token. Our
server's requests under `/twindesk/drive/` go to the link of the host session whose token they
carry; any other token is refused.

A change adopted from one computer is sent on to the others, so two computers that each meet only
this one still end up the same. If two computers send the same new file at once, the second copy
is thrown away when it lands and asked for again later, which finds nothing to do.

## Files

| File | What |
|---|---|
| `shared/drive.js` | The engine: index, scan, merge, adopt, serve |
| `shared/drive-link.js` | One session: messages, GET and PUT, the host's request handler |
| `shared/drive-host.js` | The app's side: the switch, the folder, the adapter to the app's session (`create`), or to every computer in Multi-device (`createMesh`, `hubAdapter`) |
| `shared/ui-drive.js` | The card on File Sharing |
| `shared/test/drive.js` | 2 and 3 devices: edits, deletes, conflicts, relay, tampering, Windows names |
| `shared/test/drive-link.js` | Over real HTTPS: GET, PUT, a 3 MB file, a bad token, a wrong certificate |
| `shared/test/drive-mesh.js` | Multi-device: two computers and a phone, a change passed on, requests by token |

The index lives in the app's data folder (`drive-index.json`). Choosing a new folder starts a new
index there. The old folder's files stay where they are.

## Not yet

- **Android:** a full copy in the app's storage or a folder you pick.
- **iPhone and iPad, without an extension:** a folder in the app's Documents (visible in Files).
  It syncs while the app runs, and in the background when iOS allows it.
- **Choices per device:** send only, receive only.
