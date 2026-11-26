# Debug: every device of the mesh, from any computer

The Debug tab (Multi-device, on Windows, Linux and the Mac) reaches every device of the mesh, connected
here or only through another device. It shows a device's live status, turns its verbose log on for a
while, fetches any of its logs, takes a screenshot, runs fixed diagnostics or, while allowed, any
command, and restarts TwinDesk there. A code agent on the same computer has the same tools through the
MCP server in `tools/twindesk-mcp`.

It exists because of 2026-11-25. After Ryzen9 woke from sleep, its links to the two laptops died about
4 s after every connection, for 90 minutes. Nitro only had the last 1 MB of Ryzen9's log (copied by peer
logs, after the fact); the overnight hours, Ryzen9's live state, its network adapter, Event Viewer and
the Full KVM service's log were out of reach until someone copied files by hand.

## Who may debug a device

Nobody, until the device says so: Debug › This computer › *Let these devices debug this computer*,
one switch per paired computer (`mesh.debug.allow` in `multi.json`).

- A device not let in gets `not allowed` for everything but `hello`, which says `allowed: false`.
- A request that came through another device counts only if the asker **and** the device that passed
  it on are let in: a relay is a paired device, but it could claim to speak for another.
- *Allow any command* (`mesh.debug.anyCommandUntil`) is a second switch: on for an hour, then off by
  itself. Without it, only the fixed diagnostics run.
- Every request served is one line in that device's log (`[debug] nitro asked status`); a command is
  written in full. The tab says *{name} debugged this computer in the last 2 minutes*, with a badge.

## Wire

`shared/meshdebug.js`, on the hub's bus. New types; an older app or a phone ignores them.

```
dbg.req {req, from, to, hops, op, args}
dbg.res {req, from, to, part, more, data? (first part), bin? (base64 piece), error?, ack?}
```

A device acknowledges every request it lets in (except `hello`) at once: `{ack: true, more: true}`, no
data. The answer follows when it's done, so a slow diagnostic or command is never taken for *no answer*.

| op | args | answer |
|---|---|---|
| `hello` | | name, version, os, edition, uptime, diagnostics, `allowed`, `anyCommand`, `transport` |
| `status` | | the snapshot (below) |
| `verbose` | `{tags, minutes}` | on for at most 120 min; `minutes: 0` turns it off |
| `files` | | the logs and their sizes |
| `log` | `{file, from, len}` \| `{file, tail}` \| `{file, grep}` | that range; `grep`: the lines holding the text, searched there |
| `shot` | `{display}` | a PNG of that display |
| `diag` | `{name, peer?, hours?}` | the output of a fixed diagnostic |
| `run` | `{cmd, timeout}` | only with *Allow any command* on |
| `restart` | `{what: 'app'}` | answers, then restarts |

**Through other devices.** The bus reaches only direct sessions, so a device that gets a request for
another passes it on: to that device if it's connected, else to the first connected device it's
reached through (`Mesh.known()`'s `via`). At most 4 hops; a request already seen is dropped; the answer
goes back the way the request came.

**What a link can take.**

- Answers go in pieces of 128 KB. Each piece waits while more than 512 KB is queued on the socket, so a
  5 MB log never holds up the session's pings. Otherwise the liveness check would close the link,
  which is what 11-25 looked like.
- A quiet link is held (`Quiet.hold`) while pieces go, never for good.
- Through Bluetooth: no screenshot, and at most 64 KB of any answer.

**Never waiting.** Nothing in 10 s is *no answer* (an older TwinDesk, a phone), and that device isn't
asked again for 2 minutes. A device that has answered before is never shut out so: nothing in 10 s from
it is *timeout* (busy, or its link in trouble), and the next request goes as usual. The tab asks only while it's on screen: `hello` of each device every 30 s,
the picked device's status every 5 s (30 s through Bluetooth).

## The status

`shared/debug-start.js` gathers it from parts each `mesh/main.js` registers:

- **sessions**: for each session, its state, transport, address, round trip, how long since anything
  was heard and sent, queued bytes, the fallback socket, quiet-link state, the busy flag, its input
  lane (up, round trip), and the message types it ignored;
- **quiet**: what holds the links busy, keep pinging, the last wake;
- **kvm**: mode, partner, paused, through Bluetooth;
- **graph**: the routing graph's last lines (`shared/mesh-shadow.js`);
- **fullkvm**: the service's state;
- **peers**, **process** (uptime, memory, the system's uptime and load) and the **verbose** log's state.

No keys or tokens.

## Logs

- `TwinDesk.log` (`.1`, `.2`), `crash.log` (`.1`), `link-stats.log`.
- `service` (and `service-node` on Windows): the Full KVM service's log. It's for administrators only
  on disk, so the service answers it over its pipe (`serviceLog`). On Windows that's `fullkvm.log` and
  the machine node's `node.log`. On Linux it's what the service printed, kept in memory: the journal or
  OpenRC's file is root's.

What the tab fetches is kept beside that device's peer-log copies, in `peers/<name>-<id8>/`.

## Verbose log

`applog.v(tag, …)` writes a `VERBOSE [tag]` line only while that tag is on (`link`: a socket that has
heard nothing for over 2 s, each second, from `shared/quiet.js` for every platform; `lane`: the input
lane's round trip every 10 s; `quiet`: probes and closes; `bus`: each message type every 10 s; or
`all`). It's on for at most 2 hours, saved (`mesh.debug.verbose`) so it outlives a
restart until its time is up.

## Diagnostics

`shared/debuglocal.js`. They run with `execFile` and argument lists, never a shell. A tool that isn't
installed is skipped. On Windows they're the app's own scripts (`windows/scripts/debug-*.ps1`, through
`windows/ps.js`).

| | Windows | Linux | Mac |
|---|---|---|---|
| `network` | ipconfig, netsh wlan | ip, nmcli | ifconfig, networksetup |
| `adapter-power` | each adapter's power management ("allow the computer to turn off this device"), power plan, sleep states | iw power_save, ethtool EEE | pmset |
| `events` | System log: Kernel-Power, Power-Troubleshooter, NDIS, WLAN, drivers; last wake | the journal, or without systemd (OpenRC) the readable syslog file | pmset log: sleep and wake |
| `reach` | ping + a TCP connect to that device's address and port | same | same |
| `sockets`, `processes`, `firewall`, `fullkvm` | netstat, tasklist, firewall rules, the service's state | ss, ps, firewall-cmd/ufw, systemctl or rc-service | lsof, ps, socketfilterfw |

## Screenshot

Electron's `desktopCapturer` on Windows, X11 and the Mac (which needs Screen Recording). On Wayland
the portal would ask the person every time, so the first installed tool takes it: `spectacle` (KDE),
`grim` (wlroots), `gnome-screenshot`.

## For a code agent: the MCP server

`tools/twindesk-mcp/server.js` speaks MCP on stdio, with no dependencies. It asks this computer's
TwinDesk through the Local API (`shared/localapi.js`), now in Multi-device too:

- `GET /v1/debug/devices`;
- `POST /v1/debug/ask {to, op, args}`, where `to` is a device's name, its id, or `self`.

Setup on the computer the agent runs on:

1. TwinDesk in Multi-device, **General › Local API** on.
2. On each device to debug: **Debug › Let these devices debug this computer**, with this computer on.
3. The repository's `.mcp.json` registers the server for Claude Code, or:
   `claude mcp add twindesk -- node tools/twindesk-mcp/server.js`.

Tools: `mesh_devices`, `device_status`, `device_verbose`, `device_files`, `device_log`,
`device_screenshot`, `device_diag`, `device_run`, `device_restart`. Each takes `device`.

## Tests

- `shared/test/meshdebug.test.js`, on a fake bus:
  - relayed answers, the hop limit, de-duplication;
  - a relay can't speak for another;
  - pieces and back-pressure, Bluetooth;
  - an older app, *Allow any command*;
  - capped arguments.
- `windows|linux|mac/mesh/test/debug.test.js`, on real sockets:
  - a device two links away;
  - a 5 MB log through a relay with every link staying up;
  - an older app.
- `tools/twindesk-mcp/test.js`: the MCP server spawned, through a real Local API, to a device on real
  sockets.
