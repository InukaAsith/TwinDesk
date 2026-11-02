# Windows and shared stability fixes

This change fixes stale asynchronous work after session changes, failed-transfer cleanup, stuck forwarded input, and repeated native/GPU work. It changes Windows and shared JavaScript; it does not port Windows modules into macOS or change the wire protocol.

## Scope

| Area | Result |
| --- | --- |
| Connections | Invalidated connection attempts cannot replace newer sessions. Failed IP handshakes fall back to Bluetooth; resume work is scoped to the current session and certificate pinning remains enforced before credentials are sent. |
| Network negotiation | Concurrent feature requests share network preparation; cancelled hosting/joining results cannot revive a disconnected session or flush stale file offers. |
| Wi-Fi Direct on Windows | Join/leave and host start/stop run in order. Cancellation stops further join retries; partial setup removes temporary profiles and releases radio holds. |
| Screen sharing | Off, policy changes, disconnects and cancelled Extend/Wi-Fi preparation invalidate pending capture. Sender renderer failures clear queued sessions. |
| Screen receiving | Late answers, tracks and stats cannot affect replacement sessions. Stopped viewers stop forwarding input and release held keys/buttons. |
| App windows | Stale catalogue/capture lookups cannot start unwanted streams. Concurrent source lookups share one in-flight enumeration. Input cleanup handles blur, removal and replacement windows. |
| Cursor and keyboard | Handoffs discard pending motion. Moves flush before clicks/scrolls. Key-up retains the key-down Ctrl/Cmd mapping, invalid coordinates are rejected and keyboard layout refreshes reject stale replies. |
| Clipboard | Reads recheck policy, connection and sequence; incoming text wins over a pending local read. Polls do not overlap, failed sends can retry and clipboard image failures settle. |
| Files | Validated sizes/trees, exclusive temporary files, collision handling, asynchronous destination placement, disk-failure reporting, cancellation and batch/session isolation. Fast HTTP transfer cancellation closes streams and stale callbacks cannot affect a replacement transfer. |
| Audio and camera | Stopped/replaced audio sessions ignore late negotiation and tracks. Failed audio setup releases resources. Camera resets stop frame readers/timers, close VideoFrames and ignore obsolete sessions. |
| Terminal | Concurrent requests share key generation; disconnect/disable invalidates late results. Failed generation can be retried. |
| Logging/updater | Rotation waits for the old log handle to close; updater checks time out and compare prerelease identifiers correctly. |

Performance-related settings retain their existing defaults; this change does not raise bitrates indiscriminately or claim all hardware is optimal. Single-peer Windows fixes do not automatically cover the separate `windows/mesh` implementations.

## Validation and limits

The installed-version branch was based on upstream v2.4.0 (`1cdffcf`). The contribution branch applies the fixes on top of main (`c27f3b4`), preserving newer upstream features such as ReZume. New tests use isolated process/module/renderer fixtures; shared fast-file and connection tests also use real local HTTPS/TLS sockets.

On the installed-version branch, 71 scripts and 24 affected scripts under Electron 38.8.6 passed. On current main, all 76 scripts passed under Node 25.5.0, and all 24 affected scripts passed under Electron 38.8.6. The 19 added test files contain 175 named regression/integration/success cases; existing tests gained assertions and real transfer cancellation coverage as well.

Native validation on Windows passed local desktop capture, WebRTC decode, WebGL frame generation after 20 toggles, stop/restart and cleanup. Three Wi-Fi Direct hotspot start/stop cycles passed, including a stop requested during startup, and preserved the original infrastructure Wi-Fi connection. That checks hosting, not a second device joining.

A direct connection to the paired Mac reached TCP but reset TLS before authentication. Cross-computer video, physical camera/audio output, SSH and end-to-end throughput remain unverified. No macOS native helper or macOS installed application was changed in this pass. No firewall or privacy permissions were changed.

## Controlled performance measurements

| Check | Before | After |
| --- | ---: | ---: |
| Main-thread callback wait during 128 MiB copy fallback (median, three samples) | 59.96 ms | 0.26 ms |
| File placement duration in that check | 59.92 ms | 59.81 ms |
| Progress callbacks in the real 128 MiB chunk loop | 2,048 | 2 |
| Upload calls for 60 decoded frames after 20 frame-generation toggles | 1,260 | 60 |
| Pending frame callback chains after those toggles | 21 | 1 |
| Capture enumerations for 20 overlapping app refreshes | 20 | 1 |

The copy check forced EXDEV on one local volume, rather than using a second physical drive. The chunk loop performed real disk reads, base64 encoding and hashing into an immediate sink, rather than over a network. Byte accounting remained exact; progress callbacks are capped at ten per second across concurrent transfers, with lifecycle updates immediate.

Frame and capture enumeration checks instrumented production code with controlled callbacks/deferred native results. They establish eliminated duplicate work, not GPU utilization, FPS or bandwidth. Frame generation remains optional and off by default. Native hotspot cycles took roughly 0.72, 1.36 and 1.97 seconds for start plus stop; these are not throughput measurements.

## Run the affected tests

Install the Windows dependency set with `npm ci --prefix windows`. Use Node 22 or later, put OpenSSL on PATH, and set NODE_PATH to the absolute `windows/node_modules` directory. Fixtures mock Electron where possible; suites that locate Electron also need its installed distribution (or ELECTRON_OVERRIDE_DIST_PATH for an existing distribution).

From the repository root in PowerShell:

```powershell
$env:NODE_PATH = (Resolve-Path windows/node_modules).Path
$files = @('shared/test/fastfile-regressions.js', 'shared/test/framegen-regressions.js', 'shared/test/keylayout-regressions.js', 'shared/test/netlink-regressions.js', 'shared/test/applog.js', 'shared/test/clipimage.js', 'shared/test/updates.js', 'shared/test/fastfile.js')
$files += (Get-ChildItem windows/test/*.test.js).FullName
foreach ($file in $files) {
    node $file
    if ($LASTEXITCODE) { throw "Failed: $file" }
}
```

Run scripts separately: some intentionally install process-local module mocks or exercise real sockets. Use ELECTRON_RUN_AS_NODE=1 with the Electron executable to repeat these checks under the application runtime. Native screen, hardware, permission and cross-computer checks remain separate from fixture-based coverage.

Sanitized measurement samples, native check results and validation counts: [windows-shared-validation.json](windows-shared-validation.json).
