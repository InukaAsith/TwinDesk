// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/meshdebug.js (docs/debug.md): asking a device of the mesh, directly or through others; who is let
// in (a relay can't speak for another); big answers in pieces that wait for the socket; nothing through
// Bluetooth that would stall it; an older app that never answers; Allow any command.
// Run: node shared/test/meshdebug.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MeshDebug, PIECE, HIGH_WATER, MAX_HOPS, NO_ANSWER_MS } = require('../meshdebug.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdebug-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// Devices on direct links (pairs 'AB'); each one's bus sends only to a device linked to it, delivering on
// the next turn (as a socket would). route(): direct, else the first neighbour that links to it (one hop
// of knowledge is all the tests need; a chain of 3 relays is built by hand where it matters).
function world(names, links, opts = {}) {
  const linked = (a, b) => links.some((l) => l === a + b || l === b + a);
  const nodes = {};
  const handlers = {};
  const sent = [];
  for (const me of names) {
    handlers[me] = {};
    const bus = {
      on: (type, fn) => { handlers[me][type] = fn; },
      send: (to, m) => {
        if (!linked(me, to)) return false;
        sent.push({ from: me, to, m });
        if (opts.silent && opts.silent.includes(to)) return true; // an older app: takes it, says nothing
        const copy = JSON.parse(JSON.stringify(m));
        setImmediate(() => { const fn = handlers[to][copy.t]; if (fn) fn(copy, me); });
        return true;
      },
      connectedIds: () => names.filter((n) => linked(me, n)),
    };
    const dir = fs.mkdtempSync(path.join(root, me + '-'));
    const logFile = path.join(dir, 'TwinDesk.log');
    fs.writeFileSync(logFile, `${me} started\n`);
    const served = [];
    const lines = [];
    const holds = [];
    nodes[me] = {
      dir, logFile, served, lines, holds,
      d: new MeshDebug({
        bus, self: me,
        route: (id) => (linked(me, id) ? id : (opts.via && opts.via[me] && opts.via[me][id]) || names.find((n) => linked(me, n) && linked(n, id)) || null),
        transportOf: (id) => (opts.ble && opts.ble.includes(me + id) ? 'ble' : 'ip'),
        queued: opts.queued ? (id) => opts.queued(me, id) : () => 0,
        allowed: () => (opts.allow && opts.allow[me]) || [],
        anyCommand: () => !!(opts.any && opts.any[me]),
        nameOf: (id) => id,
        log: (l) => lines.push(l),
        hold: (k, on) => holds.push([k, on]),
        onServed: (e) => served.push(e),
        wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
        local: {
          hello: async () => ({ name: me, version: '9.9.9', os: 'linux' }),
          status: async () => ({ me, sessions: [] }),
          verbose: async (a) => ({ tags: a.tags || [], minutes: a.minutes || 0 }),
          files: async () => [{ name: 'TwinDesk.log', path: logFile, size: fs.statSync(logFile).size }],
          shot: async () => ({ data: { displays: 1 }, bin: Buffer.alloc(300 * 1024, 7) }),
          diag: async (a) => ({ name: a.name, out: 'ok' }),
          run: async (a) => ({ cmd: a.cmd, code: 0, out: 'ran' }),
          restart: async () => ({ restarting: true }),
        },
      }).start(),
    };
  }
  return { nodes, sent };
}

const code = (p) => p.then(() => 'ok', (e) => e.code);
setInterval(() => {}, 1000); // meshdebug's timers are unref'd (as in the app): this keeps the test alive while it waits

(async () => {
  // Direct: hello always answers (and says whether we're let in); the rest only when let in.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] } });
    const h = await w.nodes.A.d.ask('B', 'hello');
    assert.strictEqual(h.data.allowed, true);
    assert.strictEqual(h.data.name, 'B');
    assert.deepStrictEqual((await w.nodes.A.d.ask('B', 'status')).data, { me: 'B', sessions: [] });
    assert.strictEqual(await code(w.nodes.B.d.ask('A', 'status')), 'not allowed');
    assert.strictEqual((await w.nodes.B.d.ask('A', 'hello')).data.allowed, false);
    assert.ok(w.nodes.A.lines.some((l) => /B asked status \(not let in\)/.test(l)), 'the refusal is in the log');
  }

  // Through a device: A–B–C (A and C not linked); the answer comes back the same way, once.
  {
    const w = world(['A', 'B', 'C'], ['AB', 'BC'], { allow: { C: ['A', 'B'] } });
    const r = await w.nodes.A.d.ask('C', 'status');
    assert.deepStrictEqual(r.data, { me: 'C', sessions: [] });
    assert.ok(w.nodes.B.lines.some((l) => /passing on A→C \(through C\)/.test(l)));
    const res = w.sent.filter((s) => s.m.t === 'dbg.res');
    // On each hop C's acknowledgement first (no data, more), then its answer: the same way back.
    const hop = (h) => res.filter((s) => s.from + s.to === h).map((s) => (s.m.ack ? 'ack' : 'answer'));
    assert.deepStrictEqual(hop('CB'), ['ack', 'answer']);
    assert.deepStrictEqual(hop('BA'), ['ack', 'answer']);
    assert.strictEqual(res.length, 4);
  }

  // Slow work is acknowledged at once, so it's never "no answer" (AMXLPDL's tasklist /v: 10 s); a device
  // that answered before and then says nothing gets 'timeout', and isn't shut out of the next request.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] } });
    w.nodes.B.d.local.diag = (a) => new Promise((r) => setTimeout(() => r({ name: a.name, out: 'slow' }), NO_ANSWER_MS + 1000));
    const t0 = Date.now();
    const slow = w.nodes.A.d.ask('B', 'diag', { name: 'processes' });
    assert.strictEqual((await slow).data.out, 'slow');
    assert.ok(Date.now() - t0 > NO_ANSWER_MS, 'it took longer than NO_ANSWER_MS');

    w.nodes.B.d._serve = async () => {}; // B stops answering (its link in trouble)
    assert.strictEqual(await code(w.nodes.A.d.ask('B', 'status')), 'timeout');
    assert.strictEqual(w.nodes.A.d.answers('B'), true, 'not shut out for RETRY_MS');
  }

  // A relay can't speak for another device: C lets A in but not B, so A's request through B is refused.
  {
    const w = world(['A', 'B', 'C'], ['AB', 'BC'], { allow: { C: ['A'] } });
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'status')), 'not allowed');
  }

  // Unreachable: no route here, or none at the relay.
  {
    const w = world(['A', 'B', 'C'], ['AB'], { allow: { C: ['A'] } });
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'status')), 'unreachable');
    const w2 = world(['A', 'B', 'C'], ['AB'], { via: { A: { C: 'B' } } });
    assert.strictEqual(await code(w2.nodes.A.d.ask('C', 'status')), 'unreachable', 'B has no way to C');
  }

  // At most MAX_HOPS relays: a chain of 6 (A..F) needs 4 relays to reach F: done; one more is dropped.
  {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const links = ['AB', 'BC', 'CD', 'DE', 'EF', 'FG'];
    const via = {};
    for (let i = 0; i < names.length; i++) {
      via[names[i]] = {};
      for (let j = i + 2; j < names.length; j++) via[names[i]][names[j]] = names[i + 1];
    }
    const w = world(names, links, { via, allow: { F: ['A', 'B', 'C', 'D', 'E'], G: names } });
    assert.strictEqual(MAX_HOPS, 4);
    assert.deepStrictEqual((await w.nodes.A.d.ask('F', 'status')).data.me, 'F');
    const t0 = Date.now();
    const p = code(w.nodes.A.d.ask('G', 'status'));
    // Nothing comes back from a dropped request: it's 'no answer', not a hang.
    assert.strictEqual(await p, 'no answer');
    assert.ok(Date.now() - t0 >= NO_ANSWER_MS - 50);
  }

  // A request seen already (a loop, a second path) is done once.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] } });
    let calls = 0;
    w.nodes.B.d.local.status = async () => { calls++; return {}; };
    const hb = w.nodes.B.d;
    const m = { t: 'dbg.req', req: 'x1', from: 'A', to: 'B', hops: 0, op: 'status', args: {} };
    hb._onReq({ ...m }, 'A');
    hb._onReq({ ...m }, 'A');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(calls, 1);
  }

  // A big log comes in pieces of PIECE, whole (a multi-byte character across a piece's edge too), and the
  // quiet link is held while they go, then let go.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] } });
    const body = 'x'.repeat(PIECE - 1) + 'é' + 'y'.repeat(PIECE * 2) + '\n';
    fs.writeFileSync(w.nodes.B.logFile, body);
    const r = await w.nodes.A.d.ask('B', 'log', { file: 'TwinDesk.log' });
    assert.strictEqual(r.bin.toString('utf8'), body);
    assert.strictEqual(r.data.size, Buffer.byteLength(body));
    const pieces = w.sent.filter((s) => s.m.t === 'dbg.res' && !s.m.ack);
    assert.strictEqual(pieces.length, Math.ceil(Buffer.byteLength(body) / PIECE));
    assert.deepStrictEqual(w.nodes.B.holds.map((h) => h[1]), [true, false]);
    // A range, the tail, and a search (done there: only the lines come).
    fs.writeFileSync(w.nodes.B.logFile, 'one\nkvm two\nthree\nkvm four\n');
    assert.strictEqual((await w.nodes.A.d.ask('B', 'log', { file: 'TwinDesk.log', from: 4, len: 7 })).bin.toString(), 'kvm two');
    assert.strictEqual((await w.nodes.A.d.ask('B', 'log', { file: 'TwinDesk.log', tail: 9 })).bin.toString(), 'kvm four\n');
    const g = await w.nodes.A.d.ask('B', 'log', { file: 'TwinDesk.log', grep: 'kvm' });
    assert.strictEqual(g.bin.toString(), 'kvm two\nkvm four\n');
    assert.strictEqual(g.data.lines, 2);
    assert.strictEqual(await code(w.nodes.A.d.ask('B', 'log', { file: '../../etc/passwd' })), 'no such log');
  }

  // Back-pressure: while more than HIGH_WATER waits on the socket, the next piece waits.
  {
    let queued = HIGH_WATER + 1;
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] }, queued: (me) => (me === 'B' ? queued : 0) });
    fs.writeFileSync(w.nodes.B.logFile, 'z'.repeat(PIECE * 3));
    const p = w.nodes.A.d.ask('B', 'log', { file: 'TwinDesk.log' });
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(w.sent.filter((s) => s.m.t === 'dbg.res').length, 0, 'nothing while the socket is full');
    queued = 0;
    assert.strictEqual((await p).bin.length, PIECE * 3);
  }

  // Bluetooth: no screenshot; a big log is refused rather than stalling the radio; small answers go.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] }, ble: ['BA'] });
    assert.strictEqual(await code(w.nodes.A.d.ask('B', 'shot')), 'bluetooth');
    fs.writeFileSync(w.nodes.B.logFile, 'q'.repeat(PIECE * 2));
    const r = await w.nodes.A.d.ask('B', 'log', { file: 'TwinDesk.log' });
    assert.ok(r.bin.length <= 64 * 1024, 'capped to what Bluetooth may carry');
    assert.strictEqual((await w.nodes.A.d.ask('B', 'status')).data.me, 'B');
  }

  // A screenshot over the network comes whole.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] } });
    const r = await w.nodes.A.d.ask('B', 'shot');
    assert.strictEqual(r.bin.length, 300 * 1024);
    assert.deepStrictEqual(r.data, { displays: 1 });
  }

  // Any command: only while the device there has Allow any command on; its own computer always.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] } });
    assert.strictEqual(await code(w.nodes.A.d.ask('B', 'run', { cmd: 'uptime' })), 'any command is off');
    const w2 = world(['A', 'B'], ['AB'], { allow: { B: ['A'] }, any: { B: true } });
    assert.strictEqual((await w2.nodes.A.d.ask('B', 'run', { cmd: 'uptime' })).data.out, 'ran');
    assert.strictEqual((await w.nodes.A.d.ask('A', 'run', { cmd: 'uptime' })).data.out, 'ran', 'self');
  }

  // An older app (or a phone) never answers: 'no answer' after NO_ANSWER_MS, then it isn't asked again
  // (but for hello) until RETRY_MS.
  {
    const w = world(['A', 'B'], ['AB'], { silent: ['B'] });
    assert.strictEqual(await code(w.nodes.A.d.ask('B', 'hello')), 'no answer');
    assert.strictEqual(w.nodes.A.d.answers('B'), false);
    const before = w.sent.length;
    assert.strictEqual(await code(w.nodes.A.d.ask('B', 'status')), 'no answer');
    assert.strictEqual(w.sent.length, before, 'not even sent');
  }

  // What's asked is capped: long strings cut, odd values dropped.
  {
    const w = world(['A', 'B'], ['AB'], { allow: { B: ['A'] } });
    let got = null;
    w.nodes.B.d.local.diag = async (a) => { got = a; return {}; };
    await w.nodes.A.d.ask('B', 'diag', { name: 'n'.repeat(10000), peer: { evil: 1 }, x: () => 1 });
    assert.strictEqual(got.name.length, 4096);
    assert.ok(!('peer' in got) && !('x' in got));
    assert.strictEqual(await code(w.nodes.A.d.ask('B', 'format-disk')), 'unknown op');
  }

  // An update through the mesh: put's pieces carry bytes (through a relay too), only with Allow any
  // command; never through Bluetooth; update follows the same rule.
  {
    const w = world(['A', 'B', 'C'], ['AB', 'BC'], { allow: { C: ['A', 'B'] }, any: {} });
    const got = [];
    w.nodes.C.d.local.put = async (a, bin) => { got.push([a.at, bin.length, bin[0]]); return { got: bin.length }; };
    w.nodes.C.d.local.update = async (a) => ({ installing: 'appimage', file: a.name });
    const piece = Buffer.alloc(PIECE, 9);
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'put', { name: 'x.AppImage', size: PIECE, sha256: 'f'.repeat(64), at: 0 }, piece)), 'any command is off');
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'update', { name: 'x.AppImage' })), 'any command is off');
    w.nodes.C.d.anyCommand = () => true;
    const r = await w.nodes.A.d.ask('C', 'put', { name: 'x.AppImage', size: PIECE, sha256: 'f'.repeat(64), at: 0 }, piece);
    assert.deepStrictEqual(got, [[0, PIECE, 9]], 'the piece arrived whole through B');
    assert.deepStrictEqual(r.data, { got: PIECE });
    assert.strictEqual((await w.nodes.A.d.ask('C', 'update', { name: 'x.AppImage' })).data.installing, 'appimage');
    const puts = () => w.nodes.C.lines.filter((l) => /asked put/.test(l)).length;
    const before = puts();
    await w.nodes.A.d.ask('C', 'put', { name: 'x.AppImage', size: 3 * PIECE, sha256: 'f'.repeat(64), at: PIECE }, piece);
    assert.strictEqual(puts(), before, 'a line for the first piece only, not one per piece');
    // The switch turning itself off mid-transfer: pieces of the update already begun go on, and its install;
    // a new one doesn't start.
    w.nodes.C.d.anyCommand = () => false;
    w.nodes.C.d.local.granted = (op, a) => (op === 'put' ? a.sha256 === 'f'.repeat(64) : a.name === 'x.AppImage');
    assert.deepStrictEqual((await w.nodes.A.d.ask('C', 'put', { name: 'x.AppImage', size: 3 * PIECE, sha256: 'f'.repeat(64), at: 2 * PIECE }, piece)).data, { got: PIECE });
    assert.strictEqual((await w.nodes.A.d.ask('C', 'update', { name: 'x.AppImage' })).data.installing, 'appimage');
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'put', { name: 'x.AppImage', size: 3 * PIECE, sha256: 'f'.repeat(64), at: 0 }, piece)), 'any command is off', 'a first piece always asks');
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'put', { name: 'y.AppImage', size: 3 * PIECE, sha256: 'e'.repeat(64), at: PIECE }, piece)), 'any command is off');
    w.nodes.C.d.anyCommand = () => true;
    // Too big a piece, or bytes on another op: refused before sending.
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'put', {}, Buffer.alloc(PIECE + 1))), 'bad piece');
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'status', {}, piece)), 'bad piece');
    // A put without bytes is refused there.
    assert.strictEqual(await code(w.nodes.A.d.ask('C', 'put', { at: 0 })), 'bad piece');
    // Through Bluetooth: neither the asker's own link nor a relay's.
    const wb = world(['A', 'B', 'C'], ['AB', 'BC'], { allow: { B: ['A'], C: ['A', 'B'] }, any: { B: true, C: true }, ble: ['AB', 'BC'] });
    wb.nodes.B.d.local.put = async () => ({});
    assert.strictEqual(await code(wb.nodes.A.d.ask('B', 'put', { at: 0 }, piece)), 'bluetooth');
    const wr = world(['A', 'B', 'C'], ['AB', 'BC'], { allow: { C: ['A', 'B'] }, any: { C: true }, ble: ['BC'] });
    wr.nodes.C.d.local.put = async () => ({});
    assert.strictEqual(await code(wr.nodes.A.d.ask('C', 'put', { at: 0 }, piece)), 'bluetooth', 'B doesn’t pass a piece on over Bluetooth');
  }

  console.log('meshdebug: all passed');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
