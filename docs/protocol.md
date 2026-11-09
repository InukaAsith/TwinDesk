# TwinDesk protocols: tdv1 and tdv2, fx and fx2

TwinDesk 2.5 has a new input protocol (**tdv2**) and a new file protocol (**fx2**). Both are
negotiated per session and fall back to the old ones by themselves. An older app, a Bluetooth link,
or a network that blocks UDP keeps working exactly as before.

| | Old | New in 2.5 |
|---|---|---|
| Mouse moves | **tdv1**: deltas (`k.mm`) on the TLS session (WSS over TCP) | **tdv2**: running totals on an encrypted UDP lane |
| Clicks, keys, wheel, gestures | On the session | On the lane **and** the session, numbered, applied once in order |
| Where it runs | Node, in the Electron app | `tdfast` (Rust) inside the native helper; Node's lane as a fallback |
| Files | **fx**: one HTTPS stream on the session's port, or `file.chunk` on the session | **fx2**: its own process and HTTPS server, parallel ranges, hashed while streaming |
| Chosen by | Always available | hello and welcome (`il`, `fx2`); General › Advanced › Input protocol |

## The session (unchanged)

Every link between two devices is one TLS session (WSS) on TCP **47800**, pinned to the paired
device's certificate, whether it runs on the network, through a phone's USB cable (adb) or through
Bluetooth LE. Discovery uses UDP **47801**. Control messages are JSON (`shared/protocol.js`). The
guest sends **hello**, and the host answers with **welcome**. New capabilities are added as fields in
those two messages, so an app that doesn't know a field ignores it.

### Quiet links (#143)

Each side pings every **PING_MS** (1 s) and closes the socket after **TIMEOUT_MS** (8 s) of silence.
A session that nothing uses goes quiet, so a phone's radio and CPU (and a laptop's) can
sleep (`shared/quiet.js`, `Link.kt`, `Link.swift`):

- Each side sends **`idle {on}`** whenever its own side changes. A socket is quiet only while both
  sides have said `on: true`. An older app never says it (and ignores it), so it keeps the 1 s pings.
- A side is busy while input is shared either way (the KVM silence watch runs on pings), file bytes
  move, a screen or the Remote is in use, the phone app is on screen, within 15 s of a session
  starting or of waking (sleep, unlock, screen on), or with **General › Connections › Prioritize
  performance over battery life** on. In multi-device mode only the input partner's link counts as
  busy. Clipboard, notifications and status messages don't make a side busy.
- Quiet: one ping every **5 min** (a computer that restarted can't leave a dead session up), closed
  after **11 min** of silence. A message sent while quiet is followed by one ping (a **probe**). With
  no answer within 8 s the socket closes, and the session comes back as after any drop.
- Leaving quiet, the 8 s limit counts from then. Bluetooth sockets never go quiet.
- The input lane (tdv2) between computers keeps its own 1 s idle ping.

## Input

### tdv1: everything on the session

The driving side sums pointer deltas and sends `k.mm {dx, dy}` on the session. It holds moves
back (still summed) while 64 KB wait on the socket. Clicks and keys (`k.md`, `k.mu`, `k.wh`, `k.kd`,
`k.ku`, `k.ge`) go on the same stream.

That's simple and reliable, but TCP delivers bytes strictly in order. On Wi-Fi:

- **Head-of-line blocking.** One lost packet holds back every move behind it until it's resent,
  so the pointer stalls for 20–300 ms when the air gets busy.
- **Shared stream.** A move waits behind a file chunk or a clipboard picture on the same socket.
- **Garbage collection.** Each move becomes JSON in the helper, gets parsed by Node and is then
  garbage-collected. A GC pause or a busy event loop shows up in the pointer.

tdv1 is still used with an older app, over Bluetooth, when UDP can't get through, and when you pick
**TCP (tdv1)** in General › Advanced › Input protocol.

### tdv2: the input lane

Moves go on a separate encrypted UDP socket next to the session, called the **lane**, with no
retransmission layer. Each move carries the **running total** since the pointer crossed over, so a
lost packet costs nothing: the next one carries everything. Clicks and keys keep TCP's guarantee by
going both ways at once.

#### Negotiation (capability `il`)

1. **Guest:** on an IP transport, it binds a UDP socket and adds `il: {v: 1, port}` to hello.
2. **Host:** if `il.v === 1`, it binds its own socket, makes a 32-byte random key and answers with
   `il: {v: 1, port, key}` in welcome (the key is 64 hex characters). It reaches the guest at the
   session's remote address on the guest's port.
3. **Both sides** start pinging. The lane is **up** when the first PONG comes back.
4. **No `il` in welcome** means the guest closes its lane. Input stays on the session.

The lane ends with the session, and a resumed session negotiates a new one. Wi-Fi Direct and hotspot
links are allowed. If the lane can't get through there, it never comes up.

#### Wire format (little-endian)

```
0..2  'T' 'L'
2     version = 1
3     type
4..12 seq, u64, per sender, from 1
12..  AES-256-GCM(body)
end   16-byte tag

AAD   = bytes 0..12
nonce = 00000000 ‖ seq (8 bytes)
keys  = HKDF-SHA256(key, empty salt, "twindesk-il-v1 host" | "twindesk-il-v1 guest", 32 bytes)
        Each side seals with its own role's key and opens with the peer's.

1 PING    u64 t_us
2 PONG    u64 t_us (echoed)
3 MOVE    u32 route, u32 mn, u32 es, f64 cx, f64 cy      56 bytes on the wire
4 EVENTS  u8 n, then n × {u32 es, u16 len, JSON}         the last ≤ 4 events, for redundancy
```

- `route` names the crossing, and it's reset each time the pointer moves to the other side.
- `mn` is the move number, and the receiver applies a MOVE only if its `mn` is newer.
- `cx` and `cy` are the running totals. The receiver injects the difference from what it last applied.
- `es` is the number of the last event sent before this move.

Packets are at most 1200 bytes. `shared/inputlane.js` is the reference implementation. Its golden
vectors are in `shared/test/inputlane-vectors.json`, and `native/tdfast` is tested against them.

#### The guarantees

- **Exact under loss.** Totals instead of deltas: the pointer always ends where it should, with
  nothing to resend.
- **Moves aren't sent more often than one per 2 ms**, and the first one goes at once. After the last
  move, the latest MOVE is sent again at +8 ms and +24 ms. While you drive, each ping also carries
  it for 3 s.
- **Events exactly once, in order.** Every click, key, wheel and gesture gets an event number `es`
  and a **fence** (the `route`, `mn` and totals of the moves before it). It goes on the lane and on
  the session. The receiver applies whichever copy comes first, drops the duplicate, and holds back
  any gap until it's filled. The session copy always comes.
- **A click never overtakes a move, and a move never overtakes a click.** A MOVE whose `es` is newer
  than the last event applied waits for that event. An event first applies its fence, so the click
  lands exactly where the pointer was.
- **Security.** Any packet that fails authentication is dropped. A 64-packet sliding window rejects
  replays. The keys come from the session, which is already pinned to the paired device.
- **Roaming.** The peer's address is the source of the last authenticated packet, so the lane
  follows a switch between Wi-Fi and a cable.
- **Liveness.** Pings go every 100 ms until the lane is up, then every 250 ms while driving or driven
  and every 1 s otherwise. After 3 intervals without a PONG the lane is **down**. Moves then go on
  the session as `k.mm` with `mn`, `mc: [cx, cy]` and `route`, so the totals still apply. Pinging
  continues, and the lane comes back up by itself.
- **Priority.** The socket is marked voice-class DSCP (`IP_TOS 0xB8`; a qWAVE voice flow on Windows,
  which ignores `IP_TOS`), so Wi-Fi's WMM voice queue sends input ahead of video and files. While
  you drive, Windows also turns on its Wi-Fi low-latency mode (`Wlan.cs`).

#### Native: tdfast

`native/tdfast` is the lane in Rust, with a C ABI (`tdfast.h`):

- `td_bind`, `td_start`, `td_active`, `td_drive_reset`, `td_move`, `td_fence`, `td_send_event`,
  `td_driven`, `td_hold`, `td_fence_apply` and `td_close`.
- One thread with no async runtime. A 1 ms receive timeout drives the throttle, the tail resends
  and the pings.
- `td_move` runs on the input hook's thread and never blocks.
- **Nothing is allocated per move.**

| OS | Helper | How tdfast is used |
|---|---|---|
| macOS | Swift (`Lane.swift`) | Linked statically, arm64 and x86_64, built by `mac-helper/build.sh` |
| Linux | C (`lane.c`) | Linked statically, for X11 and the uinput backend |
| Windows | C# (`Lane.cs`) | `bin\<arch>\tdfast.dll`, x64 and arm64, built by `tdfast.cmd`. The helper runs with `GCLatencyMode.SustainedLowLatency` |

On the driving side, the event tap calls `td_move` and nothing goes to stdout or Node. On the driven
side, tdfast hands the helper the delta to inject, already deduplicated and in order with the events.
Node only starts the lane and handles the events.

Node probes the helper with `lane {op: bind}`. If that fails (an older helper, a build without cargo,
`TWINDESK_NO_TDFAST`), Node runs the same wire itself in `shared/inputlane.js`, which also allocates
nothing per move. The two implementations work with each other, so a native lane on one side and a
Node lane on the other is fine. Mesh uses the Node lane, one per device session.

#### Switches

- **General › Advanced › Input protocol:** **UDP (tdv2)**, the default, or **TCP (tdv1)**. It's read
  at startup, so a change applies after a restart.
- **`TWINDESK_NO_IL=1`** keeps input on the session, and **`TWINDESK_NO_TDFAST=1`** keeps the lane in Node.
- **`TWINDESK_LANE_LOSS=0.05`** drops that share of sent packets, for testing.

#### Tests

- `shared/test/inputlane.js`: seal and open, replay, MoveApply under loss and reordering, EventOrder, two live lanes and the golden vectors.
- `shared/test/inputlane-kvm.js`
- `shared/test/tdfast-interop.js`: JS ↔ Rust on real UDP with 30% loss, IPv4 and IPv6.
- `{windows,linux}/mesh/test/kvm-lane.test.js`
- `cargo test` in `native/tdfast`.

## Files

### Before 2.5: file.chunk and fx

`file.offer`, `accept`, `end`, `done` and `cancel` are control messages on the session.

- **file.chunk:** the bytes as base64 in 64 KB `file.chunk` messages on the session itself. This is
  always available, and it's what Bluetooth and links made by `shared/netlink.js` use.
- **fx:** with hello `{fx: 1}` and welcome `{fx: token}`, on the network or a cable, the bytes go as
  one plain HTTPS stream on the session's port. The guest PUTs what it sends and GETs what the host
  sends (after `file.pull`), pinning the host's certificate. The host checks the token.

Both ran in the app's main process, so a large copy competed with the window, the clipboard and
input for the same event loop. A file was one stream, and verifying it meant reading it again.

### fx2: the file engine

- **Its own process.** `shared/fx2.js` starts `shared/fx2-engine.js` in an Electron utility process
  ("TwinDesk Files"), or in the same process under plain node or with `TWINDESK_FX2_INPROC`. It has
  its own HTTPS server on a free port with the session's identity, and the guest pins it as it pins
  the session.
- **Negotiation:** hello `fx2: 1`, welcome `fx2: {port}`, and `file.pull {fx2: 1, size}`.
- **Requests:** `PUT|GET /twindesk/fx2/<id>?i=&off=&len=&total=`, with the fx token in `x-twindesk-fx`.
- **Ranges.** A file up to 8 MB goes as one range, and a bigger one as 4 parallel ranges. The receiver
  sizes the file up front and writes each range at its offset.
- **Verified while streaming.** Both sides hash each range with SHA-256 as it streams. `file.end`
  carries the sender's hashes (`{fx2: [hex]}`), and the engine compares them, so the file is never
  read twice.
- **Receivers** use one hook (target, adopt, fail) and never see fx2's bytes.
- **Small files.** Up to 16 at once, asynchronous writes with backpressure on every receiver.
- **Hardening.** A file stops at its offered size, a full disk fails cleanly, and a sender can't name
  a temporary file.
- **Fallback.** Anything wrong before the first byte went sends that file, and the rest of the
  session's, the fx way, then as `file.chunk`. `TWINDESK_NO_FX2=1` turns fx2 off.

Measured: 10,000 files of 10 KB went from a Windows PC to a Mac in 47.6 s.

Tests: `shared/test/fx2.js` (30 MB in 4 ranges), `shared/test/fastfile.js` and `shared/test/drop-async.js`.

### The phone and fx

From 2.5.2 the Android app says `fx: 1` in hello too, and moves file bytes the fx way: it PUTs what
it sends and GETs what the computer sends after `file.pull` (`Files.kt`, `Link.fx()`), pinning the
computer's certificate as the session does. Before, its bytes went as base64 `file.chunk`, a third
more on the wire. As with computers: on the network, a cable or a Wi-Fi Direct group / hotspot, never
Bluetooth; anything wrong before a byte went sends that file and the rest as `file.chunk`
(`file.pull {failed}` one way, a refused PUT the other). An older computer gives no token, so it still
gets `file.chunk`; an older phone never asks.

Then the phone says `fx2: 1` too (not on the cable: adb reverse carries only the session's port) and
does fx2 both ways (`Fx2.kt`): its ranges in parallel, each read or written at its offset, the range
hashes in `file.end`. A file it can't read at offsets (a stream, not a file) goes the fx way alone;
anything else wrong before a byte went: that file and the rest of the session go the fx way.

### The iPhone and iPad and fx2

The iPhone and iPad app says `fx: 1, fx2: 1` in hello and does fx2 both ways (`Fx2.swift`), with the
same fallbacks as the phone: anything wrong before a byte sends that file and the rest of the session
the fx way, then as `file.chunk`. That holds on the network, a Wi-Fi Direct group or a hotspot (its own
`172.20.10.x` or the computer's), and on the cable, where `Usb.swift` mirrors the files engine's port
from welcome too. Bluetooth keeps `file.chunk`. It used to keep `file.chunk` on groups and hotspots.

Files to an iPhone or iPad whose session is on Bluetooth wait for Wi-Fi (netlink.js `holdOut`): the
computer sends `net.need {why}`, and the app moves the session onto the network both are on with
`hello {resume}` (`Link.move`), at once when it's on screen, else once its notification is tapped and
TwinDesk opens. The held offer then goes on the moved session. Nothing in 5 minutes: it goes through
Bluetooth as `file.chunk`. Off screen or out of focus the app moves the session back onto its Bluetooth
pipe the same way (`hello {resume}` over the pipe), so neither move ends the session.

### Fast files on a link made for them

Wi-Fi Direct groups and hotspots made by netlink.js carry fx and fx2 as the network does (they used
to keep `file.chunk`). The link stays up while bytes move: each side touches netlink's `files` need on
its bytes (`FastFiles.active`, `Netlink.touch`), as `file.chunk` does.

### The files engine on demand

The computers' files engine (`shared/fx2.js`) runs only when something may need it: a session, another
TwinDesk computer on the network, a socket coming in, a hello going out, or a job. It stops 30 s after
nothing does, never during a session. Its port goes in welcome, so a host whose engine isn't up yet
holds the welcome until it listens (a few tens of ms; up to 1.5 s, then without `fx2`).

### fxPlain: unencrypted file transfers

Files › Encrypt file transfers, on by default. Turned off, file bytes can go over plain HTTP:

- **Negotiation:** the guest's hello `fxPlain: 1` (a computer when its switch is off; the phone
  always, so its computer decides), the host's welcome `fxPlain: {port, fx2Port?, token}` only when
  the guest asked and the host's switch is off too. Either side without it: TLS as before.
- **Where:** `port` is the app's plain server for fx (`shared/fastfile.js`), `fx2Port` the files
  engine's (`shared/fx2-engine.js`). Same paths and requests as fx and fx2.
- **Token:** its own, random per session, sent in the encrypted welcome. The session's token never
  goes in the clear, and the plain servers take only the plain one.
- **What stays encrypted:** the session, and so `file.end`'s SHA-256s (fx2's per range). The
  receiver checks them, so a file can be read on the network but not changed unnoticed.
- **Never over the cable** on the phone: adb reverse carries only the session's port. The phone's
  plain requests use their own HTTP/1.1 client (`FxHttp.kt`), since the app's network policy refuses
  cleartext everywhere else.

### File size

`FILE_MAX_BYTES` is 16 TiB (it was 4 GiB, #143). Offers above an older app's 4 GiB are refused there
with `too_big`, as before.

## Compatibility

| This app ↔ other side | Input | Files |
|---|---|---|
| 2.5 ↔ 2.5, network or cable | tdv2 (native where the helper has tdfast) | fx2 |
| 2.5 ↔ 2.5, Wi-Fi Direct or hotspot | tdv2 if UDP gets through, else tdv1 | fx2 |
| 2.5 ↔ 2.5, Bluetooth | tdv1 | file.chunk (moves to Wi-Fi Direct when it's big) |
| 2.5 ↔ 2.4 or older | tdv1 | fx or file.chunk |
| Computer ↔ Android, network, Wi-Fi Direct or hotspot (both up to date) | tdv1 (no lane on Android yet) | fx2 (fxPlain when the computer allows it) |
| Computer ↔ Android, cable | tdv1 | fx |
| Computer ↔ Android 2.5.2+ (older) | tdv1 | fx on the network or a cable, else file.chunk |
| Computer ↔ Android, Bluetooth, or an older side | tdv1 | file.chunk |
| Computer ↔ iPhone or iPad, network, cable, Wi-Fi Direct or hotspot | tdv1 | fx2, else fx, else file.chunk |
| Computer ↔ iPhone or iPad, Bluetooth | tdv1 | file.chunk |
