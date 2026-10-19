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
  a link that is driving or being driven (or the selected one) pings every `PING_MS` (1 s) and times
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

## Tests

- Unit: `shared/test/*.js` for the core (random topologies of 2–10 nodes: every item reaches every
  node exactly once, no storms, partial meshes relay, legacy peers work).
- Integration, real sockets: `windows/test/*.js` start several real `Server` + `Pairing` +
  `LinkManager` nodes on loopback, pair them and run the scenarios (3 and 5 nodes).
- Headless app: start the app with its own `--user-data-dir` and `--remote-debugging-port` and read
  the renderer console and state over CDP; no `Uncaught` errors, the state keeps updating.
- Android cannot be compiled on the development PC: the CI build is its compile check.

## Not in this change

Transitive pairing (pair once, join everyone), chains of cursor edges (Mac → PC → phone from one
keyboard), the phone as an extra monitor, multi-monitor edges, binary file chunks.
