# Mesh: many devices connected at once

Status: design for the mesh work (see the pull request that adds it). Written to be implemented in
slices, each with tests, without changing what a two-device setup does today.

## Goals

- A device is connected to several others at the same time (up to `MAX_DEVICES` = 10).
- One keyboard and mouse drive all of them: each screen edge can lead to a different device (top: a
  Mac, bottom: a phone). Crossing an edge sends the input to the device behind it.
- One clipboard pool: copying on any device makes it pasteable on all of them.
- One notification pool: a notification on any device shows on all the others.
- Files, terminal, apps, screen sharing and the other one-to-one features follow the device the user
  picks ("selected device"): click the phone, see the phone's files; click the Mac, see the Mac's.
- Direct links, no server in between, no extra load: every pair of devices that can reach each other
  has one direct link.
- Nothing that works today with two devices may stop working: protocol v1 stays, a device that knows
  nothing about the mesh is simply a one-to-one peer.

## Topology and transport

- One WSS link per pair of devices (the existing TLS, pinned fingerprint, pairing by 6-digit code).
  No relay server. Media (screen, sound) stays WebRTC between the two devices involved.
- Who dials: a phone always dials (it cannot listen). Between two computers the one that was paired
  from ("guest") dials. If two computers hold each other as guests, the one with the smaller device id
  dials and the other waits for that inbound link (at most `INBOUND_WAIT_MS`) before dialling itself.
- A device listens on `PORT` for every guest and dials every host it was paired with. There is no
  "one session at a time" rule any more: the phone no longer pushes computers away and computers are
  not refused with `busy` because another link is up.
- Keep-alive costs scale with the number of links, so the policy depends on use:
  a link that is driving or being driven (or the selected one) pings every `PING_MS` (1 s) from each end (so both ends can show the round trip) and times
  out after `TIMEOUT_MS` (4 s), as today; every other link pings every `IDLE_PING_MS` (5 s) and times
  out after `IDLE_TIMEOUT_MS` (15 s). Any received message counts as a sign of life; a ping is only
  sent when nothing was sent on that link for the interval.

## Layers

1. **Link layer** (per platform): a server that accepts many clients, a manager of the guest links
   (one `Link` per paired host), and one *session* object per remote device that hides whether the
   device dialled us or we dialled it. Messages carry the session (device id) they came from.
2. **Mesh core** (`shared/mesh.js`, plain JS, same code on every platform that runs JS): the peer
   registry, the `Pool` (fan-out, dedupe, relay) and the `Roster` (who is connected to whom).
3. **Features**
   - *Pooled* (clipboard, notifications) talk to the mesh directly: they receive from any device and
     publish to all.
   - *Targeted* features (screen, files browser, terminal, apps, sound, wake, SMB, …) keep their
     current one-to-one code. They talk to the **selected device** through a facade with exactly the
     API of today's `Peer`/`link` object. Selecting another device re-targets the facade: the
     handlers see `closed` and then `welcome` for the new device, so a feature starts clean.
   - *Cursor and keyboard* (`kvm`): `edges` maps a side of this screen to a device id. The device
     whose physical keyboard and mouse are used is the centre of a star; an edge crossing selects the
     device behind that edge and takes it. Returning (edge or hotkey) goes home to the centre.

Naming rule (a bug of the first attempt came from reusing one name for two things): `selectedId` is a
string, `selected` is the session object; never overload them.

## Wire additions (all optional, ignored by older apps)

- `hello` and `welcome` may carry `mesh: 1`. A peer that sent no `mesh` field is treated as a plain
  one-to-one peer: it gets no roster and no relayed items.
- `mesh.roster {peers: [deviceId, …]}`: sent after `welcome` and whenever the set of direct links
  changes. Receivers keep it in the `Roster`.
- Pooled messages (`clip`, `notif`) get three optional fields, set by the device where the item
  starts: `o` (origin device id), `s` (origin sequence number, increases per origin and pool) and
  `d` (the origin's direct links at that moment, array of ids). A pooled message without `o` comes
  from a one-to-one peer: it is applied and published into the pool as if the sender were its origin.

## Pool rules (`Pool` in `shared/mesh.js`)

- `publish(msg)` stamps `o`, `s`, `d` and sends to every connected pool-capable peer.
- `receive(fromId, msg)`:
  - drop it when `o` is this device (own echo) or `(o, s)` was seen (a bounded window per origin);
  - otherwise it is fresh: the feature applies it;
  - relay: forward the unchanged message to every connected pool-capable peer that is not
    `fromId`, not `o`, and not listed in `d` (they got it from the origin directly). In a full mesh
    nothing is forwarded; where a link is missing the item still arrives, once.
  - a hop counter `h` (0 at the origin, +1 per relay, no relay once it would pass `POOL_MAX_HOPS` = 9, enough for a chain of ten devices) bounds any loop.
- A peer that switched the pool off (`pool:false` in the registry) is never sent items and items from it are ignored. A device that switched it off for itself does not call the pool at all, so it neither applies nor relays. A failed send to a direct link is not retried: that link is down and the device gets the next item after it reconnects.
- Applying an item must not publish it again (no echo): the feature remembers what it just wrote to
  the OS clipboard or showed as a notification for 30 s and ignores the OS event it causes.
- Clipboard items are text up to `CLIP_MAX_BYTES`. A device may switch the pool off for itself
  (`clip.policy`, `notif.policy`); a device that has it off neither applies nor relays for others.

## Compatibility rules

- `PROTOCOL_VERSION` stays 1. New fields and message types are additive.
- With exactly one connected device every feature behaves as before; old settings migrate
  (`pairing.json` → `pairings.json`, a list; `kvm.pcSide` → `kvm.edges`).
- Linux keeps working as a one-to-one peer until it gets its own port; a Linux or older Mac peer in
  the mesh is a leaf that is relayed to.

## Shared layout (one map for the whole mesh)

Where the devices sit relative to each other is ONE map held by every device and edited from any of
them, so the arrangement looks the same everywhere: with Windows leftmost, the Mac on its right and
the phone on the Mac's right, every screen shows exactly that. The rules are in `shared/layout.js`
(pure, tested).

- A layout is `{ rev, by, cells: { deviceId: { x, y } } }`: one cell of an integer grid per device.
  What a screen edge leads to is the nearest device on the same row (left, right) or column (top,
  bottom). Each device derives its own edges from the layout:
  `neighbors(view(layout, knownIds), selfId)`. `settings.kvm.edges` is migrated once into a layout
  (`fromEdges`) and is derived from then on.
- Only a person's edit changes the stored layout (`place`, `remove`: rev + 1, `by` = the editing
  device). Devices that appeared or went away are handled by `view()`, computed identically on every
  device from the same layout and the same known ids, never stored or sent.
- Sync: the layout is a pooled item (its own pool, message `{ t: 'layout', layout }`, the usual
  `o`/`s`/`d`/`h` stamps). A device applies an item only when it is newer (`newer`: higher rev, then
  `by`, then the canonical string: the same winner everywhere). A device that was edited publishes it;
  a device that connects sends its stored layout to the new peer, so late joiners converge. Concurrent
  edits at the same rev: one wins on every device.
- Chains: the owner is the device whose physical keyboard and mouse are used. It takes a neighbour
  (`kvm.take`). While a device B is driven, its pointer reaching an edge that leads back to the owner
  sends `kvm.home` as today; reaching an edge that leads to another device T sends
  `kvm.next { route, to: T, side, offset }` to the owner, which releases B (`kvm.release`) and takes T
  (`kvm.take` with `side: opposite(side)` and the same offset). So Windows, Mac and phone in one row
  are reached in turn from the Windows keyboard, and from the Mac keyboard in both directions. The
  helpers' return watch covers every edge that has a neighbour (`armReturn { sides }`, and the `return`
  event carries `side`). A phone driven through the owner's wireless debugging ends a chain: it has no
  edges of its own beyond the one it was entered by.
- The editor (Cursor tab, every desktop app) draws the grid with every device as a tile; click a
  tile and a free cell, or a tile and another tile to swap. Android stores and relays the layout and
  can end a chain; editing from the phone is not in this change.

## Transports per link (Bluetooth, Wi-Fi, USB cable)

Each link (one per device) has its own transport; nothing is global any more.

- **Bluetooth** (`shared/blepipe.js`): a device that is near but not on this network is reached
  through a Bluetooth pipe, which carries the same WSS over a loopback socket. A Bluetooth socket is
  marked `ws.transport = 'ble'` on the server (`ctx.transport`) and `link.transport` on the guest side,
  and it has a longer silence limit: `P.BLE_TIMEOUT_MS` (20 s) instead of `P.TIMEOUT_MS` (4 s) while busy
  and `P.IDLE_TIMEOUT_MS` (15 s) when idle, and bytes still arriving through the pipe count as a sign of
  life (a big message takes seconds). The keep-alive is the same per socket (busy ping every `PING_MS`,
  idle every `IDLE_PING_MS`).
- **Moving a session** (`hello {resume}`): once a device that is on Bluetooth is seen on the network,
  the link opens a second socket, resumes the session on it (the server's `_resume`) and keeps the
  Bluetooth one as the fallback (`ctx.alt` / `link.alt`). Each socket is checked on its own: a quiet
  fallback is closed, the session lives on. A `transport` event tells the features.
- **Per device, in the mesh**: `Session.transport` ('ble' | 'ip') is the transport of that device's
  session. The kvm reads it per partner: the Over Bluetooth switch (`kvm.ble`, the same on both sides)
  pauses cursor sharing only with the devices whose session runs through Bluetooth (`kvm._pausedFor(id)`),
  and moves are summed and sent at most every `KVM_MOVE_BLE_MS` through Bluetooth. Pooled items
  (clipboard, notifications, layout) go to every device as before, whatever its transport.
- **Wi-Fi for a session through Bluetooth** (`shared/netlink.js`, Wi-Fi Direct, a hotspot or a Wi-Fi
  network): it serves the selected device (the one-to-one features follow it). Files wait for it
  (`hub.netHold`), and the screen waits too; `net.*` messages are read from the selected device
  (`hub.netTap`).
- **Disconnect, Switch and Take over** are per link: `link.disconnect()` (no reconnect until Connect),
  `link.connect(true)` (Take over: the other computer's session with another device ends) and the
  `stopped` state (`released` / `replaced`). The tray shows "Disconnect <name>" and "Take Over <name>"
  for the selected device.
- **Calls, Messages, Photos and Files** (`shared/phonehub.js`) are a feature of the phone; the phone's
  hub is loaded once, its messages come from the phone link (`PhoneLink`), and the phone's own
  wallpaper and screen go over Wi-Fi only (`wallpaper` is left out on Bluetooth).
- **USB cable**: a phone on the cable is paired through it (`phone.wired`, the nonce of the plug-in)
  and its session can be moved onto the cable the same way (`wired.toCable`).
- **UI.via**: the status line of a link says which transport it is on (`Connected over Bluetooth`,
  `Connected over USB`, `Connected`), per device in the device list.

Limits of this change: the Android app was merged without a Kotlin build here (the CI build is its
compile check); the Windows and Mac apps were not run as Electron apps, only their node tests.

## Joining everyone

Pair a device once and the mesh pairs the rest (`shared/intro.js` is the protocol, `windows/autojoin.js`
the Windows side). A device I that is connected to two devices H and G that are not connected to each
other introduces them. H is the computer (it listens); between two computers the smaller device id, or
the side that already dials the other; two phones cannot be linked directly.

```
I -> H  mesh.intro.ask    {req, for: G, name, os}
H -> I  mesh.intro.reply  {req, for, ok, macId, macName, os, fp, port, addrs, token}   (ok:false + error otherwise)
I -> G  mesh.intro.grant  {req, macId, macName, os, fp, port, addrs, token}
```

H makes a pairing entry for G without the 6-digit code (`Pairing.grantFor`) and G stores the grant like
a finished pairing (`LinkManager.addGrant`), then dials H. `addrs` are H's IPv4 addresses, LAN first;
G tries the next one when the first fails. The introducer plans again whenever a link or a roster
(`mesh.roster` now carries `members`) changes; the same pair is not asked again within 60 s. Devices
only known through another device are listed (`Mesh.known()`, state `via` in `hub.peers()`).

Security: the introducer is a trusted device. Anyone you paired with can make this PC accept a new
device (H side) or add a host (G side), so pair only devices you trust. The introducer only forwards a
reply for a request it made, from the host it asked, once; a host never grants for the asker or itself,
nor for a device that is connected now, and at most once per device in 10 s. The token goes through the
authenticated TLS links only. Setting `mesh.autoJoin` (default on, General › "Join every device
automatically"): when off, the PC neither introduces nor accepts. Old apps ignore the `mesh.intro.*`
messages.

## Tests

- Unit: `shared/test/*.js` for the core (random topologies of 2–10 nodes: every item reaches every
  node exactly once, no storms, partial meshes relay, legacy peers work).
- Integration, real sockets: `windows/test/*.js` start several real `Server` + `Pairing` +
  `LinkManager` nodes on loopback, pair them and run the scenarios (3 and 5 nodes). `mesh-transport.test.js`
  covers a Bluetooth session's longer silence limit and a session that moves between transports.
- Headless app: start the app with its own `--user-data-dir` and `--remote-debugging-port` and read
  the renderer console and state over CDP; no `Uncaught` errors, the state keeps updating.
- Android cannot be compiled on the development PC: the CI build is its compile check.

## Not in this change

Editing the layout from the phone, the phone as an extra monitor, multi-monitor edges, binary file chunks.
