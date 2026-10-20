// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// End-to-end check of the Windows app with three REAL instances (Electron), each with its own data
// folder and ports. Not run by CI (it needs Electron and a desktop session).
//
//   node windows/test/dev/e2e-app.js
//
// Instances A, B, C (listen 47851-47853, debugging 9451-9453) are started with --hidden. B and C pair
// to A, then C pairs to B (a full triangle). The checks read UI.state in each renderer over the
// Chrome DevTools Protocol. Only the processes this script started are killed; the user's own
// TwinDesk (%APPDATA%\MacShare) is never touched: every instance gets a temporary --user-data-dir.
//
// Environment: TWINDESK_ELECTRON (default: windows/node_modules/electron/dist/electron.exe).
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const WINDOWS = path.resolve(__dirname, '..', '..');
const ELECTRON = process.env.TWINDESK_ELECTRON || path.join(WINDOWS, 'node_modules', 'electron', 'dist', 'electron.exe');
const NODES = [
  { name: 'A', port: 47851, dbg: 9451 },
  { name: 'B', port: 47852, dbg: 9452 },
  { name: 'C', port: 47853, dbg: 9453 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' (' + detail + ')' : ''}`);
  return !!ok;
}

async function waitFor(fn, what, ms = 60000) {
  const until = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error('timed out waiting for ' + what + (last ? ' (' + last.message + ')' : ''));
    await sleep(250);
  }
}

// ---- instances ----

const running = []; // {name, pid, dir, out, child}

// True when something already answers on the port (another TwinDesk, or a leftover of an earlier run).
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function startInstance(node) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twinde2e-${node.name}-`));
  const out = path.join(dir, 'out.txt');
  const fd = fs.openSync(out, 'w');
  const child = spawn(ELECTRON, [WINDOWS, '--hidden', `--user-data-dir=${dir}`, `--remote-debugging-port=${node.dbg}`], {
    env: { ...process.env, MACSHARE_DEV_PORT: String(node.port), ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  running.push({ name: node.name, pid: child.pid, dir, out, child, dbg: node.dbg });
  return child.pid;
}

// The DevTools port belongs to this instance only when its own log says it listens there.
async function waitDevtoolsOfOwn(r) {
  return waitFor(() => {
    const text = fs.existsSync(r.out) ? fs.readFileSync(r.out, 'utf8') : '';
    if (/Cannot start http server for devtools/.test(text)) throw new Error(`${r.name}: DevTools port ${r.dbg} is taken`);
    return text.includes(`DevTools listening on ws://127.0.0.1:${r.dbg}/`);
  }, `${r.name}: its DevTools to listen on ${r.dbg}`, 60000);
}

// Kills exactly the processes started above (and their children), nothing else.
function stopInstances() {
  for (const r of running) {
    spawnSync('taskkill', ['/PID', String(r.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

// ---- Chrome DevTools Protocol ----

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'evaluate failed');
    }
    return r.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function connectRenderer(node) {
  await waitDevtoolsOfOwn(running.find((r) => r.name === node.name));
  const target = await waitFor(async () => {
    const list = await getJson(`http://127.0.0.1:${node.dbg}/json`);
    return list.find((t) => t.type === 'page' && /app\.html/.test(t.url));
  }, `${node.name}: the main window`, 120000);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

// The renderer's view of the state (UI.state, as the window draws it).
async function stateOf(node) {
  const text = await node.cdp.eval('window.UI && UI.state ? JSON.stringify(UI.state) : ""');
  return text ? JSON.parse(text) : null;
}

const evalIn = (node, expression) => node.cdp.eval(expression);

// ---- the steps ----

const idOf = (state) => state.device.id;

// The peers of `node` (by device id) that the given state lists as connected.
function connectedTo(state, id) {
  return (state.peers || []).some((p) => p.id === id && p.connected);
}

async function waitState(node, pred, what, ms = 60000) {
  return waitFor(async () => {
    const s = await stateOf(node);
    return s && pred(s) ? s : null;
  }, `${node.name}: ${what}`, ms);
}

async function pairPair(dialer, host) {
  // The dialler starts pairing with the host's address; both show the same six-digit code. The code
  // element keeps an old code after a pairing, so wait for this pairing's code in the state first.
  await evalIn(dialer, `window.macshare.pair('127.0.0.1:${host.port}')`);
  await waitState(host, (s) => s.pairing && s.pairing.code, `${host.name}: the pairing request`);
  await waitState(dialer, (s) => s.pairing && s.pairing.code, `${dialer.name}: the pairing code`);
  const codeHost = (await evalIn(host, `document.getElementById('pair-code').textContent`)).replace(/\s/g, '');
  const codeDialer = (await evalIn(dialer, `document.getElementById('pair-code').textContent`)).replace(/\s/g, '');
  check(`${dialer.name} and ${host.name} show the same 6-digit code`, /^\d{6}$/.test(codeHost) && codeHost === codeDialer, `${codeDialer} / ${codeHost}`);
  // The real buttons: Allow on the host, Codes match on the dialler.
  await evalIn(host, `document.getElementById('pair-match').click()`);
  await evalIn(dialer, `document.getElementById('pair-match').click()`);
  await waitState(dialer, (s) => connectedTo(s, host.id), `${dialer.name} sees ${host.name} connected`);
  await waitState(host, (s) => connectedTo(s, dialer.id), `${host.name} sees ${dialer.name} connected`);
}

function peerIds(state) {
  return (state.peers || []).filter((p) => p.connected).map((p) => p.id).sort();
}

// Waits until a state holds, and says whether it did (the check reports the result, not the wait).
const holds = (node, pred, what, ms = 15000) => waitState(node, pred, what, ms).then(() => true, () => false);

// The shared layout (docs/mesh.md, "Shared layout"): B sets the row A - B - C through the real IPC, and
// every instance shows the same layout. C then edits it and A and B follow. Then the chain, with the
// helper events simulated (devHelperEvent; the pointer is not): A drives B through its right edge, B's
// pointer leaves to the right so A drives C, C's pointer leaves to the left so A drives B again, and B's
// pointer leaves to the left and brings everything home. Every step: the driving / driven / home state
// of each instance (UI.state.input).
async function layoutScenario(A, B, C) {
  const ev = (node, expr) => evalIn(node, expr);
  const helperEvent = (node, name, msg) => ev(node, `window.macshare.devHelperEvent('${name}', ${JSON.stringify(msg)})`);
  const setCell = (node, id, x, y) => ev(node, `window.macshare.setLayoutCell('${id}', ${x}, ${y})`);

  check('A draws the Layout card with a tile for each device', await ev(A, `UI.go('cursor')`).then(() =>
    waitFor(async () => (await ev(A, `document.querySelectorAll('.lay-tile').length`)) === 3, 'three device tiles', 15000)).then(() => true, () => false));

  // B sets the row: A at x0, B at x1, C at x2 (all on row 0).
  check('B puts A at x0 (setLayoutCell)', (await setCell(B, A.id, 0, 0)) === true);
  check('B puts B at x1', (await setCell(B, B.id, 1, 0)) === true);
  check('B puts C at x2', (await setCell(B, C.id, 2, 0)) === true);
  const row = (s) => ['A', 'B', 'C'].every((k, i) => {
    const id = { A: A.id, B: B.id, C: C.id }[k];
    return s.layout && s.layout.cells[id] && s.layout.cells[id].x === i && s.layout.cells[id].y === 0;
  });
  const sameAs = (ref) => (s) => row(s) && s.layout.rev === ref.layout.rev && s.layout.by === ref.layout.by
    && JSON.stringify(s.layout.cells) === JSON.stringify(ref.layout.cells);
  const refB = await waitState(B, row, 'B shows the row', 15000);
  check('A, B and C all show the same UI.state.layout (the row A-B-C)', await holds(A, sameAs(refB), 'A layout')
    && await holds(B, sameAs(refB), 'B layout') && await holds(C, sameAs(refB), 'C layout'));

  // C edits the layout (here: it places itself at its own cell again, a new revision): A and B follow.
  check('C edits the layout (setLayoutCell from C)', (await setCell(C, C.id, 2, 0)) === true);
  const refC = await waitState(C, (s) => s.layout.by === C.id && s.layout.rev > refB.layout.rev, 'C shows its own edit', 15000);
  check('A and B follow the edit from C (same rev, by C)', await holds(A, sameAs(refC), 'A follows C')
    && await holds(B, sameAs(refC), 'B follows C'));

  // Chain. A drives B.
  await helperEvent(A, 'edge', { side: 'right', offset: 0.5 });
  check('edge right: A is driving, with B selected', await holds(A, (s) => s.input === 'driving' && s.mesh.selectedId === B.id, 'A driving B'));
  check('edge right: B is driven, C is home', await holds(B, (s) => s.input === 'driven', 'B driven') && (await stateOf(C)).input === 'home');

  // B's pointer leaves to the right: B hands the input on, A releases B and drives C.
  await helperEvent(B, 'return', { side: 'right', offset: 0.5 });
  check('return right on B: A is driving, with C selected', await holds(A, (s) => s.input === 'driving' && s.mesh.selectedId === C.id, 'A driving C'));
  check('return right on B: C is driven, B is home', await holds(C, (s) => s.input === 'driven', 'C driven')
    && await holds(B, (s) => s.input === 'home', 'B home'));

  // C's pointer leaves to the left, towards B (not the driver): A takes B again.
  await helperEvent(C, 'return', { side: 'left', offset: 0.5 });
  check('return left on C: A is driving, with B selected again', await holds(A, (s) => s.input === 'driving' && s.mesh.selectedId === B.id, 'A driving B again'));
  check('return left on C: B is driven, C is home', await holds(B, (s) => s.input === 'driven', 'B driven again')
    && await holds(C, (s) => s.input === 'home', 'C home'));

  // B's pointer leaves to the left, back to A: everything home.
  await helperEvent(B, 'return', { side: 'left', offset: 0.5 });
  check('return left on B: A is home, B is home, C is home', await holds(A, (s) => s.input === 'home', 'A home')
    && await holds(B, (s) => s.input === 'home', 'B home') && await holds(C, (s) => s.input === 'home', 'C home'));
  check('the selection stays on B after going home', await holds(A, (s) => s.mesh.selectedId === B.id, 'A keeps B selected'));
}

async function main() {
  const byName = Object.fromEntries(NODES.map((n) => [n.name, n]));
  try {
    for (const n of NODES) {
      const busy = (await portBusy(n.port)) || (await portBusy(n.dbg));
      if (busy) throw new Error(`${n.name}: port ${n.port} or ${n.dbg} is in use by something else; not started, nothing touched`);
    }
    console.log('starting instances (electron: ' + ELECTRON + ')');
    for (const n of NODES) console.log(`  ${n.name}: pid ${startInstance(n)}, listen ${n.port}, debugging ${n.dbg}, data ${running.find((r) => r.name === n.name).dir}`);

    for (const n of NODES) {
      n.cdp = await connectRenderer(n);
      await waitState(n, (s) => s.host && s.host.on, `${n.name}: the host is listening`, 120000);
      const s = await stateOf(n);
      check(`${n.name} starts, listens and shows its state`, !!s && Array.isArray(s.peers) && s.device && !!s.device.id);
    }
    const [A, B, C] = [byName.A, byName.B, byName.C];
    for (const n of NODES) n.id = idOf(await stateOf(n));
    check('three different device ids', new Set([A.id, B.id, C.id]).size === 3);

    // Step 1: B and C pair to A.
    await pairPair(B, A);
    check('B is connected to A (both sides)', connectedTo(await stateOf(A), B.id) && connectedTo(await stateOf(B), A.id));
    await pairPair(C, A);
    check('C is connected to A (both sides)', connectedTo(await stateOf(A), C.id) && connectedTo(await stateOf(C), A.id));

    // Step 2: C pairs to B: the triangle.
    await pairPair(C, B);
    check('C is connected to B (both sides)', connectedTo(await stateOf(B), C.id) && connectedTo(await stateOf(C), B.id));

    // Every instance lists the other two as connected, and the roster knows the triangle.
    for (const n of NODES) {
      const others = NODES.filter((x) => x !== n).map((x) => x.id).sort();
      const s = await waitState(n, (st) => JSON.stringify(peerIds(st)) === JSON.stringify(others), `${n.name}: both other devices connected`, 30000);
      check(`${n.name}: peers lists the other two as connected`, JSON.stringify(peerIds(s)) === JSON.stringify(others));
      // In a triangle each peer's direct links are the two other devices (its roster, as this device knows it).
      const roster = await waitState(n, (st) => (st.peers || []).every((p) => Array.isArray(p.direct) && p.direct.length === 2), `${n.name}: every roster`, 30000);
      check(`${n.name}: each peer's direct links are known (triangle)`, roster.peers.every((p) => p.direct.length === 2));
      check(`${n.name}: the mesh registry has the two devices`, Array.isArray(s.mesh.connectedIds) && s.mesh.connectedIds.length === 2, `connectedIds ${s.mesh.connectedIds.length}`);
      check(`${n.name}: exactly one device is selected`, s.peers.filter((p) => p.selected).length === 1 && !!s.mesh.selectedId);
      // Keep-alive pings go only on a quiet link (docs/mesh.md), so a busy link has no round-trip time of
      // its own; a link is measured by the side that pings it. Known limitation: the dialling side of an
      // idle link is often never pinged by itself, so its round-trip time can stay empty. The check needs
      // at least one connected device with a round-trip time per instance, and the state keeps updating.
      const rttOk = await waitFor(async () => {
        const st = await stateOf(n);
        return st.peers.some((p) => p.connected && typeof p.rtt === 'number');
      }, `${n.name}: a round-trip time`, 20000).then(() => true, () => false);
      const now = await stateOf(n);
      check(`${n.name}: a connected device shows a round-trip time (state keeps updating)`, rttOk,
        rttOk ? JSON.stringify(now.peers.map((p) => [p.connected, p.selected, p.rtt])) : 'none');
    }

    // Selection: the window follows the selected device. A selects the one of B and C it does not have selected.
    const first = await stateOf(A);
    const target = first.mesh.selectedId === B.id ? C : B;
    const other = target === B ? C : B;
    await evalIn(A, `window.macshare.setActivePeer('${target.id}')`);
    const after = await waitState(A, (s) => s.mesh.selectedId === target.id, 'A selects ' + target.name);
    check(`A selects ${target.name}: peers[].selected and the window state follow`, after.peers.find((p) => p.id === target.id).selected === true
      && !!after.peer && after.peer.id === target.id && after.peers.filter((p) => p.selected).length === 1, `peer ${after.peer && after.peer.name}`);
    await evalIn(A, `window.macshare.setActivePeer('${other.id}')`);
    const after2 = await waitState(A, (s) => s.mesh.selectedId === other.id, 'A selects ' + other.name);
    check(`A selects ${other.name}: the selection moves back`, !!after2.peer && after2.peer.id === other.id
      && after2.peers.find((p) => p.id === target.id).selected === false);

    // The Devices card and the Found nearby rows are drawn (Overview tab).
    await evalIn(A, `UI.go('overview')`);
    // textContent: innerText would give the card title in capitals (text-transform) and hidden text is not drawn.
    const drawn = await waitFor(async () => (await evalIn(A, `document.body.textContent`)).includes('Devices'), 'the Devices card', 15000).then(() => true, () => false);
    check('A draws the Devices card', drawn);

    // Clipboard pool: a copy on A reaches B and C. The three instances share one Windows clipboard, so
    // only A sends in this check (B and C receive): otherwise every instant poll would publish the same copy.
    await evalIn(B, `window.macshare.setClipboard({ send: false })`);
    await evalIn(C, `window.macshare.setClipboard({ send: false })`);
    const marker = 'TWINDESK-E2E-' + Date.now();
    await evalIn(A, `window.macshare.copyText(${JSON.stringify(marker)})`);
    const hits = (s, dir) => (s.clipboard.history || []).filter((h) => h.dir === dir && h.text.startsWith(marker)).length;
    for (const n of [B, C]) {
      const s = await waitState(n, (st) => hits(st, 'in') >= 1, `${n.name}: the copy from A`, 30000).catch(() => null);
      check(`${n.name} gets A's copy in its clipboard history, once`, !!s && hits(s, 'in') === 1, s ? '' : 'not received');
    }
    const sentA = await waitState(A, (st) => hits(st, 'out') >= 1, 'A remembers its copy', 15000).catch(() => null);
    check('A remembers its own copy as sent, once', !!sentA && hits(sentA, 'out') === 1);

    // The shared layout and the chain (docs/mesh.md): the layout is set through the real IPC, the helper's
    // events come through devHelperEvent (the same listener the helper uses).
    await layoutScenario(A, B, C);

    // The state keeps updating after every step: a fresh read from the main process works.
    for (const n of NODES) {
      const fresh = await n.cdp.eval('window.macshare.getState().then((s) => Array.isArray(s.peers))');
      check(`${n.name}: getState() answers after the steps`, fresh === true);
    }
  } catch (e) {
    failed++;
    console.log('FAIL  the run stopped: ' + e.message);
  } finally {
    for (const n of NODES) if (n.cdp) n.cdp.close();
    stopInstances();
    await sleep(500);
  }

  // No errors in the instances' output.
  for (const r of running) {
    const text = fs.existsSync(r.out) ? fs.readFileSync(r.out, 'utf8') : '';
    check(`${r.name}: no Uncaught error in its output`, !/Uncaught/.test(text), r.out);
    check(`${r.name}: no [state] error in its output`, !/\[state\] error/.test(text));
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks PASSED');
  process.exit(failed ? 1 : 0);
}

main();
