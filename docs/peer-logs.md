# The other devices' logs

In Multi-device, every computer keeps a copy of each connected device's log in its own log folder, so
what went wrong on one computer can be read at any of them (and a report can carry them all).
`shared/peerlogs.js`, on Windows, Linux and the Mac.

## Where

The log folder (Settings › About › Log folder, or the Multi-device tab › Logs › Open log folder):
`%APPDATA%\MacShare\logs`, `~/.config/MacShare/logs`, `~/Library/Logs/TwinDesk`. Under `peers/`, a folder
per device, `<name>-<first 8 of its id>`:

```
peers/Ryzen9-62896d96/TwinDesk.log   its log, as it grows (rotated to .1.log past 10 MB)
peers/Ryzen9-62896d96/crash.log      its crash.log, every 5 minutes
```

The first copy of a device's log is its last 1 MB; after that only what's new, every 30 s. A device
whose log was rotated or started again is marked in the copy (`---- … its log was rotated or started
again ----`).

## Switches

Multi-device tab › Logs, both on by default (a device you paired with already uses this computer's
mouse and keyboard):

- **Let the other devices read this computer's log** (`mesh.shareLogs`): off, a device that asks is told
  so, and its copy says "Its log isn't shared".
- **Copy the other devices' logs here** (`mesh.collectLogs`): off, nothing is asked.

## Wire

On the hub's bus, between connected devices only:

```
log.get  {req, file: 'TwinDesk.log' | 'crash.log', from: byte offset | null}
log.data {req, file, size, from, data: base64, more} | {req, error}
```

`from` is an offset in that device's current file; `null`, or an offset past its end, is its last 1 MB.
A piece is at most 128 KB; `more` asks for the next at once. Any other file name is `TwinDesk.log`:
nothing else of the computer can be read. An older app ignores `log.get` (it logs the type once) and
is asked again every 2 minutes.

## Tests

`shared/test/peerlogs.test.js`: the first copy and then only what's new, a big log in pieces (a
character cut between two pieces stays whole), a rotation, crash.log, both switches, an older app,
and a request for another file.
