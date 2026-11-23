# Mesh graph: one graph per service

Multi-device runs the one-to-one features through a facade: one copy of each feature, pointed at the
selected device, told `welcome`/`closed` when the selection moves. Every routing question then has
several answers that drift apart: the selected device (`hub.selectedId`), the audio route (sticky, else
selected), the KVM partner, and each pair's switches read relative to the selected device (`pairFor`).
The bugs of November 2026 were each two of these disagreeing: a device's sound stuck on a device that
never answered, Ryzen9's accept ignored because the sound was routed to another device, "MacBook is
using nitro5" while Ryzen9 was. Replaying what a device said (`shared/peerstate.js`) fixed the messages
that were lost; it can't fix which device a feature should follow.

This replaces "which device is selected" with a graph per service, decided by one pure function.

## The model

**Nodes** are the devices in the mesh, with what they can do (OS, app version, the services they have,
speakers, microphone, camera).

**A directed graph per service.** An edge `u → v` means u provides the service to v:

| Service | `u → v` means |
| --- | --- |
| sound | u's sound plays on v |
| mic | u's microphone is a microphone on v |
| camera | u's camera is a camera on v |
| screen | u's screen is shown on v |
| cursor | u's mouse and keyboard drive v |
| clipboard | what u copies is on v's clipboard |
| notifs | u's notifications show on v |
| files | u's shared folder is mounted on v |
| terminal | u opens a shell on v |
| phone | phone u's calls, texts and hub are on computer v |

Every pair starts as a candidate edge, both ways. Each edge then has a stage and, below the top, the
reason it stopped there:

```
candidate ──► allowed ──► active ──► live
          caps,        the service's     the connection
          switches     limits and rank   is up
```

- **allowed**: both devices can do it (`caps`), and the switches on both sides say yes (`pair.sync`
  keeps a pair's switches the same on both devices). Changes only with settings or devices.
- **active**: the service's limits kept it (below). Computed, never stored.
- **live**: its connection is up (WebRTC, an SMB mount, an SSH session). The green dot is `live`; an
  edge that isn't shows why, in the words the stage gave.

## Services declare their rules

The table in `shared/mesh-graph.js` (`SERVICES`) is the only place a service's routing is written:

| Service | Per provider | Per receiver | Decides | Pick when limited |
| --- | --- | --- | --- | --- |
| sound | many (cap 6) | many | the provider | – (every allowed edge) |
| mic | 1 | 1 | the provider | the device using me |
| camera | 1 | 1 | the provider | the device using me |
| screen | 4 (bandwidth) | many | the provider | the ones that asked |
| cursor | one token, the whole mesh | – | the layout and the pointer | where the pointer went |
| clipboard | many | many | – | – (broadcast) |
| notifs | many | many | – | – |
| files | many | many | each side, for its folder | – |
| terminal | many | 1 per window | the target | the one opened |
| phone | 1 | 1 | the phone | the computer last chosen on the phone |

**Pruning, the same for every service.** When a limit is exceeded, the edges with the highest rank stay
active and the rest are pruned with a reason ("Mic is with Ryzen9"). The rank is fixed:

1. pinned by the person ("always send this computer's sound to Ryzen9");
2. the **input peer**: the device using this computer, or the one this computer uses;
3. the last device chosen by hand (today's selection);
4. the device id, so that two devices with the same answers above still come out the same everywhere.

**The provider decides.** nitro alone decides where nitro's sound goes; the receiver only says whether it
takes it (its switch). No service needs both sides to have picked each other, which is what kept sound
off when two computers had different devices selected.

## The input peer

The device whose mouse and keyboard last reached this computer, or the device this computer's mouse
last went to. It changes only when a different device takes over or this computer crosses into another
one; the pointer coming home doesn't clear it. A new one counts after a dwell (2 s) or a click, so a
pointer passing through a device on its way elsewhere doesn't move sound and the mic.

| What happens | nitro's input peer |
| --- | --- |
| Ryzen9's pointer comes into nitro | Ryzen9 |
| it goes back to Ryzen9, an hour on Ryzen9 alone | still Ryzen9 |
| the Mac takes nitro over | the Mac |
| nobody since nitro started | none: the selection, as today |

Popups and the Overview name the input peer ("Ryzen9 is using nitro5"), never the selected device.

## A feature per edge, not one moved around

Each active edge gets its own copy of the one-to-one feature (`Sound`, `Mic`, `Smb`, …) with its own
link to that one device; it opens when the edge becomes active and closes when it stops. The one-to-one
classes already assume one peer, so they barely change, and:

- no facade switching, no replay of what a device said (`peerstate.js`), no goodbyes, no sticky routes,
  no `pairFor`: an edge's copy has its own state and its own policy;
- **older devices keep working**: to an older app an edge is an ordinary one-to-one session;
- one-to-one is a graph with two nodes, on the same code path.

`SmbSet` (`shared/smb-mesh.js`, network folders) is already this, for one service.

**Sound to several devices.** The provider captures once (the `twindesk_sound` source on Linux, WASAPI
loopback on Windows) and every active edge has its own WebRTC connection fed from that one track: own
switch, own dot, own volume. About 64–128 kbps and one Opus encoder per receiver; the table caps it at 6.
Receivers are not in step with each other (each has its own jitter buffer, 40–150 ms): different rooms
are fine, the same room echoes. A device that plays several others gets one stream each, mixed by
PipeWire or WASAPI.

## On the wire

Each service's "do you take it" message (`audio.policy`, `mic.policy`, `cam.policy`, …) becomes one:
`edge.consent {svc, on}`, kept per session and said again on reconnect. A new service needs no policy
message of its own, and the matrix (below) shows every edge's consent the same way. The old messages
stay for older apps, which the edge's one-to-one copy speaks anyway.

## The UI

A matrix per service: providers in rows, receivers in columns, a switch per cell, the dot when live, the
reason on hover. "Who is using me", "where my sound goes" and every popup read the graph, so they can't
disagree with what happens.

## Stability

- An active edge that came from the input peer changes after the dwell, or at once on a click: a quick
  crossing never moves sound back and forth.
- Every change of an active edge is one line with its reason: `[graph] mic nitro→Ryzen9 active: the
  device using me`.

## KVM stays its own model

The pointer is one token moving over a spatial layout (`docs/mesh.md`, the monitor map), and that part
works. Its graph is the layout's adjacency; it only tells the graph the input peer.

## Tests

The decision is a pure function, so it's tested as one (`shared/test/mesh-graph.test.js`):

- **randomized**: random meshes (1–8 devices, random capabilities, switches, connect order, takeovers),
  and after every step: limits kept, switches respected, the same inputs give the same edges, nothing
  active that isn't allowed, the input peer outranks the selection;
- **scenarios**: each bug from November 2026 as a script ("the Mac connects first, Ryzen9 takes nitro
  over → nitro's mic goes to Ryzen9 and the popup names Ryzen9").

## Steps

1. **Shadow.** `shared/mesh-graph.js` (the table, the decision, the input peer) and
   `shared/mesh-shadow.js`, run beside today's code on Windows and Linux. It changes nothing: it logs
   what the graph would do next to what happens, as `[graph]` lines in TwinDesk.log, once per change.
   A week of real use shows where they differ.
2. **Sound**: a `Sound` per edge, several receivers from one capture.
3. **Mic, camera, screen.**
4. **Phone services** (phone hub, calls, TwinDesk iPhone): one to one, the phone decides.
5. **Remove** the facade switching, `peerstate.js`, sticky routes and `pairFor` once nothing uses them.
6. **The matrix UI.**

### Step 1 in detail

The shadow covers the services that are routed on this computer today, so its "would" can be compared
with a "does":

| Service | would (the graph) | does (today) |
| --- | --- | --- |
| sound, from here | every allowed edge (many) | the audio route's device, and whether it sends |
| mic, from here | the input peer, else the selection | the audio route's device, and whether it sends |
| the name in popups | the input peer, else the selection | `peerName()`: the selected device |

Allowed comes from today's switches through the same reads the features make (`pairFor` on the pair's
`audio` switches, `audio.micSend`). The other side's consent is its half of the pair's switch, which
`pair.sync` keeps the same on both devices; today's `audio.policy` isn't used for it, because it says
where that device routes its sound, not whether it would play ours.

### Step 2 as built

`shared/sound-mesh.js` (`SoundSet`) makes a `Sound` per connected device on `hub.scoped(id)`, the link
`pcscreenset.js` builds screen sharing on: each hears only its device and sends only to it, with its
own policy both ways. Whether an edge sends is the sound graph's (`resolve('sound')`, every allowed edge
up to 6); the edge's `Sound` does the rest as in one-to-one. Nothing holds sound to a device any more
(the audio route is the microphone's alone). A new selection re-applies every edge, because
`settings.audio` is the selected device's pair (`pairFor`).

For now each edge's `Sound` has its own hidden window and its own capture: on Linux they share the one
`twindesk_sound` source (loopback.js counts its users); on Windows each takes the loopback, and the one
`setDisplayMediaRequestHandler` reads `audio.muteLocal` for all. One capture feeding several
connections in one window is the next refinement; it changes nothing on the wire.

The other side needs nothing new: an older app hears our policy and offers on its own session as
ever. Between two apps that both have `SoundSet`, sound goes both ways to every device at once;
an older app still sends its own sound only to its route's device.

A line is written only when a service's would or does changes:

```
[graph] sound: would Ryzen9, AMXLPDL-47H-169 (MacBook-Air-de-Ortega: Send is off for it) | does MacBook-Air-de-Ortega, not sending
[graph] input peer: Ryzen9 (it drives this computer)
```
