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

## Compatibility

| This app ↔ other side | Input | Files |
|---|---|---|
| 2.5 ↔ 2.5, network or cable | tdv2 (native where the helper has tdfast) | fx2 |
| 2.5 ↔ 2.5, Wi-Fi Direct or hotspot | tdv2 if UDP gets through, else tdv1 | file.chunk |
| 2.5 ↔ 2.5, Bluetooth | tdv1 | file.chunk (moves to Wi-Fi Direct when it's big) |
| 2.5 ↔ 2.4 or older | tdv1 | fx or file.chunk |
| Computer ↔ Android | tdv1 (no lane on Android yet) | As before 2.5 |
