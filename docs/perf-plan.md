# Performance plan: input, files, screen

Goal: the lowest input latency and jitter, the fastest file transfers, and the best screen quality, with no lost features and full compatibility with older apps (2.x Electron clients, the Android app, Bluetooth, multi-device). This is speed and hardening work, not a feature: the UI doesn't change, and every fast path is negotiated and falls back to today's path.

## Status (2026-11-03)
- **P0** in code: the `[link]` line has RTT p99/max, the lane's RTT and the event loop's p99/max; `TWINDESK_PING_MS`. The baseline numbers (docs/perf-results.md) still need real runs on Wi-Fi.
- **P1** in code, except the Windows Wi-Fi low-latency mode (Wlan.cs, needs a Windows build): async writes on the Mac with backpressure for every receiver (`fx.pressure`), the queue in mac/filesend.js, 16 small files at once. Tests: shared/test/drop-async.js, shared/test/fastfile.js.
- **P2** in code everywhere: the one-to-one apps on Mac, Windows and Linux, and mesh (one lane per device session: a lane per Link on the guest side, `LanePool` with a pre-bound spare on the host side, `LaneMesh` in each mesh kvm.js). Tests: shared/test/inputlane.js (golden vectors), shared/test/inputlane-kvm.js, and {windows,linux}/mesh/test/kvm-lane.test.js (30% loss, and an older app without a lane). The mesh tests that record `k.mm` on the bus set `TWINDESK_NO_IL`. Lane events skip `swapRole`, which leaves `k.*` alone.
- **P5** in code: shared/screencodec.js orders the codecs (H265, then H264 High, Main, Baseline) for every sender and viewer, and `withBitrate` knows H265. Share screen › Picture › Codec on each computer (`sharing.codec` on the Mac, `pcScreen.codec` on Windows and Linux): H.264 (default, until the glass-to-glass measurement says HEVC is no slower), Automatic (H.265 when both have it), or H.265 only. Every app switches `WebRtcAllowH265Send,WebRtcAllowH265Receive` on at start (in its single `enable-features` switch), so the setting works on the next share without a restart; H.264 leaves H.265 out of the offer. Env `TWINDESK_SCREEN_CODEC` overrides the setting; `TWINDESK_NO_H265=1` leaves the features off. Each sender logs the codec the answer settled on. Test: shared/test/screencodec.js (also loads it beside every renderer, as the pages do).
- **P4** in code for the one-to-one apps (mesh doesn't use `fx`): shared/fx2-engine.js (the engine: its own HTTPS server, ranges, hashing while streaming) and shared/fx2.js (runs it in a utility process, or in-process under plain node or with `TWINDESK_FX2_INPROC`). Negotiated as hello `fx2: 1`, welcome `fx2: {port}`, and FILE_PULL `{fx2: 1, size}`; an early failure falls back to `fx`, then to chunks. Receivers get one `fastfile.receiverHook`, and `file.end` carries the range hashes, so a verified file isn't read again. Kill switch: `TWINDESK_NO_FX2`. Tests: shared/test/fx2.js (30 MB in 4 ranges), plus a real Electron run with the utility process (50 MB). macOS may ask once whether the new "TwinDesk Files" process may accept connections.
- **P3** in code: native/tdfast (Rust, C ABI in tdfast.h; `cargo test` checks the golden vectors; shared/test/tdfast-interop.js runs JS↔Rust on real UDP under 30% loss). There's no separate lanehelper.js: `InputLane.useNative(helper)` probes the helper with `lane {op: bind}` and keeps the JS lane when that fails (no cargo at build time, an old helper, `TWINDESK_NO_TDFAST`). Mesh stays on the JS lane.
  - Mac: Lane.swift, built by mac-helper/build.sh when cargo is there (arm64 and x64; checked live).
  - Linux: linux-helper/src/lane.c, X11 and the uinput backend; checked live in the VM on X11 (exact moves, an event holding the move behind it until `done`).
  - Windows: Lane.cs loads `bin\<arch>\tdfast.dll` (windows-helper/tdfast.cmd builds it). The installer adds "TwinDesk (input lane)" for the helper exe. Not compiled yet: see the Windows checks. DSCP is `IP_TOS` only; qWAVE isn't done.
  - Left: flake.nix builds the Linux helper without the native lane (cargo in the Nix sandbox needs `cargoLock`). CI runners already have cargo. The AUR package repacks the .deb, so it needs nothing.

## Findings (2026-11-03)

**Where TwinDesk's latency comes from today**
```
helper ─stdout JSON─▶ Node main ─JSON·WSS·TLS·TCP─▶ Node main ─stdin JSON─▶ helper
```
1. **TCP on Wi-Fi.** One lost packet holds back every later message until it is resent (head-of-line blocking), which causes stalls of 20–300 ms. This is the main source of lag spikes. Clipboard images and old-style file chunks share the same socket, so keys wait behind them too.
2. **Stalls on Node's main thread, on both ends:** garbage collection, one `fs.writeSync` per received chunk (mac/drop.js:234), an O(n²) scan of the file queue (mac/filesend.js:208), and renderer IPC.
3. **Wi-Fi power save and background scans.** Windows can switch these off through an API.

Already native and good: capture and injection (the helpers), and screen encoding (Chromium WebRTC with hardware H.264, playout delay 0, FlexFEC and DSCP).

**Decisions**
- **Don't port the app shell to Tauri.** Electron's Chromium gives the same WebRTC stack, hardware codecs and field trials on every OS. WKWebView and WebKitGTK don't (WebKitGTK often ships without WebRTC), so screen sharing, camera and calls would get worse on Mac and Linux.
- **Define each fast wire format once.** Ship it in JS first, because that is quick, testable and interoperable. Then move the hot loop into a Rust core that speaks the same bytes, so a JS peer and a Rust peer always interoperate.
- **Rust rather than C++ for the native core.** One crate cross-compiles for Mac, Windows, Linux and Android. Parsing network input is memory-safe. Ready-made crypto and socket crates mean no OpenSSL build per OS. A C ABI links into Swift, C, C# (P/Invoke) and Kotlin (JNI).

## Compatibility rules (every phase)
- `PROTOCOL_VERSION` stays 1, and existing messages keep their meaning. A new field is sent only after the peer has advertised it, following the `fx` pattern in hello/welcome (mac/link.js:181 and :267, mac/server.js:216).
- If a capability is unknown, use today's path. If a fast path fails at runtime, use today's path for the rest of that session, silently.
- Never use a fast path over Bluetooth, with a phone as the peer (`local.drives()`), or on a multi-hop mesh route. A session can move between IP and Bluetooth mid-way (server.js emits `'transport'`), so check the current transport on every use.
- Kill switches for debugging: env `TWINDESK_NO_IL=1` and `TWINDESK_NO_FX2=1`.
- Order: Mac first, then Windows, then Linux, then mesh (`*/mesh/`). After each, run `for f in shared/test/*.js; do node $f; done` and the Linux VM test (`vm-test.sh`).

## P0: Measure (½ day)
1. shared/applog.js 30-second line: add the event-loop delay p99 and max from `perf_hooks.monitorEventLoopDelay({resolution: 10})`, and reset it after each line. Update shared/test/applog.js.
2. Dev env `TWINDESK_PING_MS`: overrides the host's ping interval (`P.PING_MS` in server.js). Log RTT p50/p95/p99/max every 10 s.
3. Write the baseline to docs/perf-results.md. Scenarios: wired idle; Wi-Fi idle; Wi-Fi + a 5 GB transfer; Wi-Fi + screen share; Wi-Fi + 2% loss (in the Linux VM: `sudo tc qdisc add dev <if> root netem loss 2% delay 2ms 1ms`). Metrics for each: RTT p99, RTT max, event-loop p99. Re-run after every phase.

## P1: Quick wins, no wire change (1 day)
1. **Asynchronous writes when receiving.** In mac/drop.js `_chunk`, replace `fs.writeSync` with an ordered write chain per transfer (`t.q = t.q.then(() => write(fd, buf))`) and count `t.pending` bytes. Keep the hash, `got` and `seq` updates synchronous. In `_end` and `_abort`, `await t.q` before closing, verifying or renaming.
   - Backpressure: in shared/fastfile.js, when `deliver()` returns a Promise, call `req.pause()` until it resolves. Receivers return a Promise only when `t.pending > 8 MB`.
   - Do the same in windows/filerecv.js, windows/dragrecv.js, linux/filerecv.js, linux/dragrecv.js and their mesh copies wherever writes are synchronous, or the write stream's `'finish'` isn't awaited before verifying.
2. **The O(n²) file queue in mac/filesend.js `_next`.** Each call copies the whole `outgoing` map into an array to find the next accepted file, so 10,000 files cost seconds of main-thread time. Keep `this.ready = []`: push ids in the FILE_ACCEPT handler, shift them in `_next`, and skip ids that are gone. windows/ and linux/filedrop.js already use a queue.
3. **More small files at once.** In shared/fastfile.js, keep 16 files in flight while the next file is under 1 MB and 4 otherwise. Senders call `fx.parallelFor(size)`. Set the agent's `maxSockets` to 18.
4. **Windows Wi-Fi low-latency mode.** New file windows-helper/src/Wlan.cs:
   - `WlanOpenHandle(2, …)` and `WlanEnumInterfaces`.
   - For each connected interface: `WlanSetInterface(h, guid, 3 /*media_streaming_mode*/, 4, &TRUE)` and `WlanSetInterface(h, guid, 2 /*background_scan_enabled*/, 4, &FALSE)`.
   - Keep the handle open while the mode is on. Closing the handle restores the settings, and Windows also restores them if the helper crashes.
   - Helper command `wifiLowLatency {on}`. windows/kvm.js turns it on while driving or driven; the screen-share code turns it on while sharing or viewing. Ignore errors.

Done when: event-loop p99 stays ≤ 5 ms during a 5 GB receive; a folder of 10,000 × 10 KB files sends at least 3× faster; RTT p99 over Windows Wi-Fi is lower.

## P2: Input lane over UDP, in JS (3–4 days), capability `il`
Moves go over an encrypted UDP lane without any reliability layer: every packet carries the cumulative totals, so the next packet heals a lost one. Clicks, keys and wheel go over both the lane and WSS, with an event number. The receiver applies whichever copy arrives first, in order, and drops the duplicate. That gives UDP latency with TCP's delivery guarantee, and all of kvm.js's logic stays where it is.

**Where it lives.** Put it next to `this.fx = new FastFiles(...)` (mac/peer.js; grep `new FastFiles` on Windows and Linux). `peer.lane()` returns the live lane, or null for Bluetooth, a phone peer, an old peer, or when the kill switch is set. Peer sends lane events through `swapOut`. Incoming lane events go through `swapIn` and then out on the same `t:<type>` path as WSS messages, so kvm.js receives both copies at its existing handlers.

**Negotiation**
- Guest (link.js): if the transport is IP, bind the lane socket first, then add `il: {v: 1, port}` to hello.
- Host (server.js, on hello): if `il.v === 1` and the port is valid, bind a socket, generate `key = randomBytes(32)`, and add `il: {v: 1, port, key: hex}` to welcome. The host's peer address is the WSS remote address (strip `::ffff:`) with the guest's port. Wi-Fi Direct and hotspot links are allowed, unlike `fx`; if the lane can't get through there, it simply never comes up.
- Guest, on welcome: check `/^[0-9a-f]{64}$/` and a port between 1 and 65535, then start. If there is no `il`, close the lane.
- Both sides start sending PINGs at once, which opens stateful firewalls. The lane is **up** once a PONG comes back. When the session ends or resumes, close the lane; the next welcome creates a new one.
- Firewalls: the Windows rule for TwinDesk.exe covers any port. If Linux firewalld blocks inbound UDP, the lane never comes up and input stays on WSS.

**Wire format (little-endian).** shared/inputlane.js is the reference implementation. Golden vectors go in shared/test/inputlane-vectors.json, for P3 to test against.
```
0..2 'T''L' | 2 ver=1 | 3 type | 4..12 seq u64 (per sender, starts at 1) | AES-256-GCM(body) | 16-byte tag
AAD = bytes 0..12. nonce = 00000000 ‖ seq (8 bytes).
keys = HKDF-SHA256(key, empty salt, info "twindesk-il-v1 host" | "twindesk-il-v1 guest", 32 bytes);
       seal with your own role's key, open with the peer's.
1 PING    u64 t_us
2 PONG    u64 t_us (echoed)
3 MOVE    u32 route, u32 mn, u32 es, f64 cx, f64 cy   (56 bytes on the wire; es = the last event sent before it)
4 EVENTS  u8 n, then n × {u32 es, u16 len, JSON}      (the last ≤4 events, for redundancy)
```
- A MOVE whose `es` is newer than the last event applied waits for that event (its lane copy may be lost; the WSS copy always comes), so a click never lands after moves that followed it.
- Receiving: drop any packet that fails authentication. Keep a 64-wide replay window (as WireGuard does). The peer's endpoint is the source of the last authenticated packet, so the lane follows a switch between Wi-Fi and cable. Packets are at most 1200 bytes.
- Pings: every 100 ms until the lane is up; then every 250 ms while driving or driven, and every 1 s otherwise. The lane is **down** after 3 intervals without a PONG. Keep pinging while it is down.
- Sending moves: throttle to one MOVE per 2 ms, sending the first one at once (at most 500 per second on the air). After the last move, resend the latest MOVE at +8 ms and +24 ms, so the pointer still ends in the right place if the final packet was lost. While driving, each ping (for 3 s after the last move) also carries the latest MOVE again.
- Dev env `TWINDESK_LANE_LOSS=0.05` drops that share of sent packets.

**What shared/inputlane.js exports**
- `InputLane`, an EventEmitter: `bind()→port`, `start(key, ip, port)`, `active(bool)`, `up`, `sendMove(s)`, `sendEvent(msg)`, `nextEs()`, `close()`. It emits `up`, `down`, `move` and `event`.
- `MoveTotals`: `reset(route)`, `add(dx, dy)→{route, mn, cx, cy}`, `current()`.
- `MoveApply`: `reset(route)`, `take(s)→{dx, dy} | null`. It applies only when `mn` is newer than the last one applied.
- `EventOrder`: `reset()`, `push(msg)→[messages in es order]`. It drops duplicates and holds back a gap until it is filled; the WSS copy always fills it.
- `seal` and `open`.

**kvm.js glue** (mac, windows and linux, then mesh/kvm.js for direct links only; about 30 lines each)
- Driving:
  - In `_take`, call `lt.reset(route)`.
  - KvmMoves' `send` calls `_driveMove(m)`. With no lane, do exactly what happens today. With the lane up, call `lane.sendMove(lt.add(...))`. With the lane down, send WSS `k.mm` with `mn`, `mc: [cx, cy]` and `route` added.
  - KvmMoves' `backlog` returns 0 while the lane is up.
- Discrete events (`k.md`, `k.mu`, `k.wh`, `k.kd`, `k.ku`, `k.ge`; the `_drive(this.keys.tag(e))` call site): when a lane exists, add `es: lane.nextEs()` and the fence `mn`, `mc` and `route` from `lt.current()`. Send over WSS, and also send on the lane if it is up.
- Driven:
  - In `_onTake`, call `ma.reset(m.route)`.
  - A lane `move`, or a WSS `k.mm` that has `mn`, goes to `_laneMove(s)`: require `s.route === this.peerRoute`, compute `d = ma.take(s)`, then call `_onK({t: K_MOVE, dx: d.dx, dy: d.dy})`. Speed, drag-in arming and injectMoves are unchanged.
  - A message with `es` (from either path) goes through `eo.push`. For each message that comes out: if its `mn` is newer, apply its fence through `_laneMove` first, then call `_onK(m)`.
  - A message without `es` takes today's path.

**Tests** (shared/test/inputlane.js; plain node + assert, like the existing tests)
- seal/open; tampered, replayed and out-of-order packets against the window.
- MoveApply gives exact totals under loss and reordering. EventOrder handles duplicates and gaps.
- Two lanes on 127.0.0.1 come up. When one peer goes silent, the lane goes down and moves fall back to WSS.
- No `il` means `lane()` is null.
- The golden vectors.

Done when: with Wi-Fi and 2% loss, no cursor stall is longer than 20 ms (over TCP today, 200 ms or more); no key or click is ever applied twice or out of order; an old app and a new app work together unchanged.

## P5: Screen share (½–1 day; do this before P4)
- **Prefer HEVC when both sides have it.** Order codecs H265, then H264 High, then Main, then the rest:
  - Senders: the `rank` function in mac/capture.js, the Windows and Linux senders, and mac/appsend-renderer.js.
  - Viewers: `setCodecPreferences` in mac/pcview-renderer.js:158 and in the Windows and Linux viewers.
  - Add `H265` to the rtpmap regex in `withBitrate` and to the encoder label.
  - If `RTCRtpSender.getCapabilities('video')` has no H265 in Electron 44, add `WebRtcAllowH265Send,WebRtcAllowH265Receive` to the **single** `enable-features` switch. Linux already has one, so merge into it.
  - With an older app, SDP negotiation picks H264 by itself.
  - Add a hidden setting `screen.codec: auto | h264`.
- **Measure before and after.** For glass-to-glass latency, film a millisecond timer shown on both screens with a 240 fps phone camera. Also record the WebRTC stats `totalEncodeTime` and `jitterBufferDelay`. Ship HEVC only if latency is unchanged and the picture is sharper at the same Mbps.
- The Windows Wi-Fi low-latency mode from P1 also helps the stream.

## P4: Fast files v2 (3–4 days), capability `fx2`
This moves the file bytes, TLS and hashing out of the main process, and sends big files as parallel ranges. `fx` and `file.chunk` remain the fallbacks.
- shared/fx2/ runs in an Electron `utilityProcess.fork`, talking to main through `parentPort`. It runs its own HTTPS server on an ephemeral port using the session identity, pinned the same way as today, with the `fx` token as authentication. It also makes the outgoing requests.
- Add `fx2: 1` to hello, and `fx2: {port}` to welcome next to `fx`. If the connection fails before any byte is sent, that file goes over `fx`, through the existing `early()` logic.
- Requests: `PUT|GET /twindesk/fx2/<id>?off=&len=`. A file up to 8 MB goes as one range; a bigger one goes as 4 parallel ranges. The receiver truncates the tmp file to the full size up front (`ftruncate`) and writes at offsets.
- Integrity: both sides hash each range with SHA-256 while it streams. `file.end` gets an extra field `fx2: [hex per range]`, and the utility process compares them, so there is no second read of the file.
- Receivers get one hook. At accept, call `fx.target(id, tmpPath)` and close their own fd. On success, `receiver.adopt(id)` runs the rename/`file.done` part of `_end`. To make that possible, split `_end` into verify and finish in mac/drop.js, windows/ and linux/filerecv.js and dragrecv.js, and the mesh copies.
- Only if measurements fall short of the link: replace the utility process with a Rust binary (tokio + rustls) that speaks the same fx2 HTTP. The wire is the same, so nothing else changes.

Done when: at least 1 GB/s over 10 GbE or a Thunderbolt bridge; on Wi-Fi, at least 90% of what `iperf3` measures; event-loop p99 stays at idle levels during a transfer.

## P3: Native lane, Rust `tdfast` inside the helpers (4–6 days, per OS), same wire
This takes Node out of the move path on both ends: event tap → UDP → injection.
- **Crate** `native/tdfast/`, `crate-type = ["staticlib", "cdylib"]`.
  - Dependencies: `aes-gcm`, `hkdf`, `sha2`, `socket2`, and `windows-sys` on Windows.
  - One thread, with no tokio: `recv` with a 1 ms timeout drives the throttle, the tail resends and the pings.
  - `td_move` runs on the event tap or hook thread, so it must not block: a Mutex around the state, a non-blocking `sendto`.
  - `cargo test` checks the golden vectors.
- **C ABI** (`tdfast.h`), mirroring inputlane.js one to one: `td_bind()→port`, `td_start(role, key, ip, port, cb, ctx)`, `td_active(on)`, `td_drive_reset(route)`, `td_move(dx, dy)`, `td_fence(&route, &mn, &cx, &cy)`, `td_send_event(json, len)`, `td_driven(route, speed)`, `td_hold(on)`, `td_fence_apply(route, mn, cx, cy, &dx, &dy)`, `td_close()`.
- **Callback kinds:**
  - move delta: deduplicated and speed applied; the helper injects it directly.
  - event JSON: the helper writes it to stdout as `{event: 'laneEv', msg}`.
  - up/down: the helper writes `{event: 'lane', up}`.
- **DSCP:** mark the socket EF/voice so Wi-Fi's WMM voice queue sends input ahead of screen video and files. Mac and Linux: `IP_TOS 0xB8`. Windows: qWAVE `QOSAddSocketToFlow(QOSTrafficTypeVoice)`. Best effort; ignore failures.
- **Helper protocol:**
  - New command `lane {op: bind | start | active | route | driven | hold | event | close}`.
  - The helper's ready line includes `caps: {lane: 1}`.
  - While the lane is up and the side is driving, the event tap calls `td_move` and writes nothing to stdout. Captured discrete events carry a `fence` for Node.
  - When the lane is down, the helper writes `k.mm` with `mn` and `mc`, as in P2.
  - Driven side: `hold` follows `drop.dragIn.arming`, and `speed` comes from the config.
- **Node:** shared/lanehelper.js has the same interface as `InputLane`, backed by the helper. `peer.lane()` picks it when `helper.caps.lane` is set, and the P2 JS lane otherwise. P2 and P3 peers interoperate.
- **Build:**
  - Mac: cargo for aarch64 and x86_64, `lipo` into mac-helper/lib/libtdfast.a, a C target with a module map in Package.swift plus `linkedLibrary("tdfast")`, all run from mac/build-app.sh.
  - Windows: `tdfast.dll` next to the helper exe, `[DllImport(..., CallingConvention = Cdecl)]`, the callback delegate kept in a static field so the GC doesn't collect it. installer.nsh adds an allow rule for the helper exe, which now listens on a port.
  - Linux: link libtdfast.a (`-lpthread -ldl -lm`); flake.nix gets `rustPlatform` and `cargoLock`; the AUR package gets `makedepends=cargo`.
  - CI: add the Rust toolchain to the three workflows.

Done when: driven-side move-to-inject time doesn't change under heavy UI or transfer load (event-loop stalls no longer show up in input timing), and the lane's RTT is about the same as ICMP ping.

## Not doing now
- A Tauri or Rust rewrite of the app shell (see Decisions).
- A custom capture → encode → UDP → decode video stack. That is months of work. Revisit only if the P5 numbers show WebRTC adding more than about 2 frames on top of network time.
- An input lane on Android. Later, it can be a Kotlin port of the same wire (`javax.crypto` AES/GCM and `DatagramSocket`). The phone's Remote touchpad would gain the most.

## Order
P0 → P1 → P2 (Mac↔Windows, then Linux, then mesh) → P5 → P4 → P3. One PR per phase, with the P0 numbers in its description.
