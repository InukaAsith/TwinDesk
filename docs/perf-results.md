# Performance results (docs/perf-plan.md)

## 2026-11-04: Windows 11 PC ↔ Mac, same 5 GHz Wi-Fi

The PC is on 802.11ac (866 Mbps link, 100% signal), with the installed 2.5.0-beta.1 from main plus the Windows work (qWAVE, the first-session gate). The PC is the guest. The Mac ran the current main.

**Input lane (P2/P3)**
- The native lane is up 0.3 s after launch (`[lane] native (the helper's)`, then `[lane] up (native)`, rtt 18–27 ms at start). The lane's two sockets on Windows are `::` and `0.0.0.0` on the same port.
- WSS rtt from the `[link]` line, idle: p50 15 ms, p99 70–135 ms. During a 1 GB send: p50 46–67 ms, p99 up to 603 ms. That is the head-of-line blocking the lane avoids; moves don't wait behind it.

**Wi-Fi low-latency mode (P1, Wlan.cs)**: `wifiLowLatency` answers `applied: 1` on Wi-Fi. `ping -n 120` to the Mac:

| | p50 | p95 | p99 | max | pings > 50 ms |
|---|---|---|---|---|---|
| off | 6 ms | 76 ms | 124 ms | 124 ms | 13 |
| on | 5 ms | 88 ms | 120 ms | 120 ms | 16 |

No difference, so the spikes don't come from the PC's background scans. Suspect the Mac's side (AWDL, power save) or the router. Measure from the Mac next.

**Files (P1/P4)**, PC → Mac, timed from the Wi-Fi adapter's sent bytes:
- 10,000 × 10 KB files: 47.6 s (about 210 files/s). The PC's event loop had one 344 ms stall when the batch started (the folder walk).
- 1 GB, fx2: 62.4 s, 17.1 MB/s (peak 20.7).
- 1 GB, `TWINDESK_NO_FX2=1` (fx): 17.3 MB/s, the same.
- fx2 and fx are equal, so the engine isn't the limit at this speed. The Wi-Fi path is (about 140 Mbps). iperf3 PC ↔ Mac is needed to say how close to the link this is.

**Memory**
- Helper standalone: 23.0 MB private and 10 threads idle; after `lane bind` (tdfast.dll loaded): 23.9 MB and 12 threads. The native lane costs about 1 MB and 2 threads.
- The fx2 utility process (`node.mojom.NodeService`): 25.5 MB private, 60 MB working set. It runs for the app's whole life, as the host's welcome needs its port at once.

**Not measured yet:** the cursor and clicks under clumsy loss, H.264 vs H.265 glass-to-glass latency and sharpness, a cancelled transfer, Bluetooth, an old app. All of these need someone at the screens.
