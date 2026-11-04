// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/inputlane.js: packets, the replay window, totals under loss and reordering,
// event order, two lanes on 127.0.0.1, the kill switch, the golden vectors (for the native lane).
// Run with: node shared/test/inputlane.js   (TWINDESK_IL_VECTORS=write rewrites the vectors)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../inputlane.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
};

const keepAlive = setInterval(() => {}, 1000); // the lane's own timers don't hold the process
(async () => {
  const quiet = console.log;
  console.log = (...a) => { if (!/^\[lane\]/.test(String(a[0]))) quiet(...a); };

  // ---- seal / open ----
  const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const host = L.deriveKeys(KEY, 'host');
  const guest = L.deriveKeys(KEY, 'guest');
  assert.ok(host.tx.equals(guest.rx) && host.rx.equals(guest.tx), 'each opens what the other seals');
  assert.ok(!host.tx.equals(host.rx), 'two directions, two keys');
  const body = L.encodeMove({ route: 3, mn: 7, es: 2, cx: 10.5, cy: -4.25 });
  const pkt = L.seal(host.tx, L.TYPE.MOVE, 1, body);
  assert.strictEqual(pkt.length, 56, 'a MOVE is 56 bytes');
  const o = L.open(guest.rx, pkt);
  assert.deepStrictEqual(L.decodeMove(o.body), { route: 3, mn: 7, es: 2, cx: 10.5, cy: -4.25 });
  assert.strictEqual(o.seq, 1);
  assert.strictEqual(L.open(host.rx, pkt), null, 'not with the wrong direction');
  for (const i of [0, 3, 5, 20, pkt.length - 1]) {
    const bad = Buffer.from(pkt);
    bad[i] ^= 1;
    assert.strictEqual(L.open(guest.rx, bad), null, `tampered byte ${i}`);
  }
  assert.strictEqual(L.open(guest.rx, pkt.subarray(0, 20)), null, 'too short');
  const big = L.seal(host.tx, L.TYPE.MOVE, 2 ** 40 + 5, body);
  assert.strictEqual(L.open(guest.rx, big).seq, 2 ** 40 + 5, 'a seq past 32 bits');

  // ---- replay window ----
  const w = new L.ReplayWindow();
  const take = (s) => (w.ok(s) ? (w.mark(s), true) : false);
  assert.ok(take(1) && take(3) && take(2), 'out of order is fine');
  assert.ok(!take(2) && !take(3), 'a replay goes');
  assert.ok(take(100), 'a jump ahead');
  assert.ok(!take(36), 'too old');
  assert.ok(take(37) && !take(37), 'just inside the window, once');
  assert.ok(!take(0), 'seq 0 never');

  // ---- events ----
  const evs = [1, 2, 3, 4, 5].map((es) => ({ es, json: Buffer.from(JSON.stringify({ t: 'k.kd', code: `Key${es}` })) }));
  const dec = L.decodeEvents(L.encodeEvents(evs));
  assert.deepStrictEqual(dec.map((e) => e.es), [2, 3, 4, 5], 'the newest four');
  assert.strictEqual(dec[3].code, 'Key5');

  // ---- totals under loss and reordering ----
  const mt = new L.MoveTotals();
  mt.reset(5);
  const sent = [];
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < 1000; i++) {
    const dx = Math.sin(i) * 3.3;
    const dy = Math.cos(i * 0.7) * 2.1;
    tx += dx;
    ty += dy;
    sent.push(mt.add(dx, dy));
  }
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const got = sent.filter(() => rnd() > 0.3); // 30% lost
  for (let i = 0; i < got.length - 1; i++) if (rnd() < 0.2) [got[i], got[i + 1]] = [got[i + 1], got[i]]; // reordered
  got.push(sent[sent.length - 1]); // the tail resend
  const ma = new L.MoveApply();
  ma.reset(5);
  let ax = 0;
  let ay = 0;
  for (const s of got) {
    const d = ma.take(s);
    if (d) { ax += d.dx; ay += d.dy; }
  }
  assert.ok(Math.abs(ax - tx) < 1e-9 && Math.abs(ay - ty) < 1e-9, `exact totals (${ax} vs ${tx})`);
  assert.strictEqual(ma.take({ ...sent[999] }), null, 'a duplicate adds nothing');
  assert.strictEqual(ma.take({ ...sent[999], route: 4, mn: 5000 }), null, 'another crossing');

  // ---- event order ----
  const eo = new L.EventOrder();
  assert.deepStrictEqual(eo.push({ es: 2 }), [], 'a gap holds');
  assert.deepStrictEqual(eo.push({ es: 1 }).map((m) => m.es), [1, 2], 'filled: both, in order');
  assert.deepStrictEqual(eo.push({ es: 2 }), [], 'a duplicate goes');
  assert.deepStrictEqual(eo.push({ es: 3 }).map((m) => m.es), [3]);
  assert.deepStrictEqual(eo.push({ es: 3 + 600 }, true), [], 'far ahead from the lane: dropped');
  assert.strictEqual(eo.held.size, 0);

  // ---- LaneDrive + LaneDriven, end to end without sockets ----
  {
    const lane = { up: true, es: 0, moves: [], evs: [], nextEs() { return ++this.es; }, sendMove(s) { this.moves.push({ ...s }); }, sendEvent(m) { this.evs.push(m); } };
    const wss = [];
    const drive = new L.LaneDrive(() => lane);
    drive.reset(9);
    drive.move(5, 0, (m) => wss.push(m));
    drive.event({ t: 'k.md', b: 0 }, (m) => wss.push(m));
    drive.move(10, 0, (m) => wss.push(m));
    drive.event({ t: 'k.mu', b: 0 }, (m) => wss.push(m));
    assert.strictEqual(wss.length, 2, 'only the events on WSS while the lane is up');
    assert.deepStrictEqual(wss.map((m) => [m.es, m.mn, m.mc[0]]), [[1, 1, 5], [2, 2, 15]], 'numbered and fenced');
    assert.deepStrictEqual(lane.moves.map((s) => s.es), [0, 1], 'a move names the event before it');

    const log = [];
    let route = 0;
    const dn = new L.LaneDriven({ route: () => route, move: (dx, dy) => log.push(`m${dx}`), deliver: (m) => log.push(m.t) });
    dn.move(lane.moves[0]); // ahead of kvm.take
    assert.deepStrictEqual(log, []);
    route = 9;
    dn.take(9);
    assert.deepStrictEqual(log, ['m5'], 'the early move goes at kvm.take');
    // The click's lane copy is lost; the move after it arrives first: it waits for the WSS copy.
    dn.move(lane.moves[1]);
    assert.deepStrictEqual(log, ['m5'], 'the move waits for the click before it');
    dn.event(wss[0]);
    assert.deepStrictEqual(log, ['m5', 'k.md', 'm10'], 'click, then the move');
    dn.event(lane.evs[1], true);
    dn.event(wss[1]);
    assert.deepStrictEqual(log, ['m5', 'k.md', 'm10', 'k.mu'], 'the second copy goes');

    // Lane down: k.mm with totals on WSS.
    lane.up = false;
    drive.move(1, 2, (m) => wss.push(m));
    const mm = wss[wss.length - 1];
    assert.ok(mm.t === 'k.mm' && mm.mn === 3 && mm.mc[0] === 16 && mm.mc[1] === 2 && mm.dx === 1, 'k.mm carries the totals');
    dn.wssMove(mm);
    assert.deepStrictEqual(log.slice(-1), ['m1']);

    // No lane: today's path.
    const none = new L.LaneDrive(() => null);
    assert.strictEqual(none.move(1, 1, () => {}), false);
    const plain = [];
    none.event({ t: 'k.kd', code: 'KeyA' }, (m) => plain.push(m));
    assert.deepStrictEqual(plain, [{ t: 'k.kd', code: 'KeyA' }], 'no es, no fence');
  }

  // ---- the kill switch ----
  {
    process.env.TWINDESK_NO_IL = '1';
    const a = new L.InputLane({ role: 'guest' });
    await a.bind();
    assert.strictEqual(a.helloField(), null, 'no il in hello');
    assert.strictEqual(a.offer({ v: 1, port: 1234 }, '127.0.0.1'), null, 'no il in welcome');
    a.close();
    delete process.env.TWINDESK_NO_IL;
  }

  // ---- two lanes on 127.0.0.1 ----
  {
    const g = new L.InputLane({ role: 'guest' });
    const h = new L.InputLane({ role: 'host' });
    await g.bind();
    await h.bind();
    const hello = g.helloField();
    assert.ok(hello.v === 1 && hello.port > 0);
    assert.strictEqual(h.offer({ v: 2, port: hello.port }, '127.0.0.1'), null, 'an unknown version: no lane');
    assert.strictEqual(h.offer({ v: 1, port: 0 }, '127.0.0.1'), null, 'a bad port: no lane');
    const welcome = h.offer(hello, '127.0.0.1');
    assert.ok(/^[0-9a-f]{64}$/.test(welcome.key));
    assert.strictEqual(g.accept({ ...welcome, key: 'zz' }, '127.0.0.1'), false, 'a bad key: no lane');
    assert.ok(g.accept(welcome, '127.0.0.1'));
    await until(() => g.up && h.up);
    assert.ok(g.rttMs !== null && g.rttMs < 50, `rtt ${g.rttMs}`);

    const moves = [];
    const evs = [];
    h.on('move', (s) => moves.push({ ...s })); // the lane reuses its move object
    h.on('event', (m) => evs.push(m));
    g.active(true);
    const mt2 = new L.MoveTotals();
    mt2.reset(1);
    for (let i = 0; i < 50; i++) g.sendMove(mt2.add(1, -1));
    await until(() => moves.length && moves[moves.length - 1].mn === 50);
    assert.ok(moves.length < 20, `throttled (${moves.length} packets for 50 moves)`);
    const tail = moves.length;
    await wait(40);
    assert.strictEqual(moves.length, tail + 2, 'two tail resends');
    assert.deepStrictEqual([moves[moves.length - 1].cx, moves[moves.length - 1].cy], [50, -50]);

    g.sendEvent({ t: 'k.kd', code: 'KeyA', es: g.nextEs(), route: 1, mn: 50, mc: [50, -50] });
    await until(() => evs.length);
    assert.strictEqual(evs[0].code, 'KeyA');
    assert.strictEqual(evs[0].es, 1);

    // Packets from someone without the key: ignored.
    const dgram = require('dgram');
    const s = dgram.createSocket('udp4');
    const n = moves.length;
    await new Promise((r) => s.send(L.seal(Buffer.alloc(32), L.TYPE.MOVE, 1, L.encodeMove(mt2.current())), h.port, '127.0.0.1', r));
    await wait(30);
    s.close();
    assert.strictEqual(moves.length, n, 'a stranger’s packet');

    // One side goes silent: the other's lane goes down within three pings.
    const downAt = Date.now();
    const down = new Promise((r) => g.once('down', r));
    h.stop();
    await down;
    assert.ok(Date.now() - downAt < 1500, 'down soon');
    assert.strictEqual(g.up, false);
    const drive = new L.LaneDrive(() => g);
    const fallback = [];
    drive.reset(2);
    drive.move(3, 4, (m) => fallback.push(m));
    assert.strictEqual(fallback[0].t, 'k.mm', 'moves fall back to WSS');
    g.close();
    h.close();
  }

  // ---- loss on a real pair: TWINDESK_LANE_LOSS ----
  {
    process.env.TWINDESK_LANE_LOSS = '0.3';
    const g = new L.InputLane({ role: 'guest' });
    const h = new L.InputLane({ role: 'host' });
    delete process.env.TWINDESK_LANE_LOSS;
    await g.bind();
    await h.bind();
    g.accept(h.offer(g.helloField(), '127.0.0.1'), '127.0.0.1');
    await until(() => g.up, 4000);
    const ma2 = new L.MoveApply();
    ma2.reset(1);
    let sx = 0;
    h.on('move', (s) => { const d = ma2.take(s); if (d) sx += d.dx; });
    const mt3 = new L.MoveTotals();
    mt3.reset(1);
    for (let i = 0; i < 30; i++) {
      g.sendMove(mt3.add(2, 0));
      await wait(3);
    }
    await wait(80);
    // 30% loss on each of the last packet and its two resends: lost all three about 3% of runs.
    assert.ok(sx === 60 || sx >= 50, `the pointer ends where it should (${sx})`);
    g.close();
    h.close();
  }

  // ---- golden vectors (the native lane checks the same bytes) ----
  {
    const file = path.join(__dirname, 'inputlane-vectors.json');
    const k = L.deriveKeys(KEY, 'host');
    const t = (n) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); return b; };
    const make = () => ({
      key: KEY,
      hostTx: k.tx.toString('hex'),
      guestTx: k.rx.toString('hex'),
      packets: [
        { role: 'host', type: L.TYPE.PING, seq: 1, body: t(123456).toString('hex') },
        { role: 'guest', type: L.TYPE.PONG, seq: 2, body: t(123456).toString('hex') },
        { role: 'guest', type: L.TYPE.MOVE, seq: 3, move: { route: 4, mn: 9, es: 1, cx: 12.5, cy: -3 } },
        { role: 'guest', type: L.TYPE.EVENTS, seq: 2 ** 32 + 1, events: [{ es: 1, json: '{"t":"k.md","b":0}' }, { es: 2, json: '{"t":"k.kd","code":"KeyA"}' }] },
      ].map((p) => {
        const body = p.move ? L.encodeMove(p.move) : p.events ? L.encodeEvents(p.events.map((e) => ({ es: e.es, json: Buffer.from(e.json) }))) : Buffer.from(p.body, 'hex');
        const sealKey = p.role === 'host' ? k.tx : k.rx;
        return { ...p, body: body.toString('hex'), wire: L.seal(sealKey, p.type, p.seq, body).toString('hex') };
      }),
    });
    if (process.env.TWINDESK_IL_VECTORS === 'write') fs.writeFileSync(file, JSON.stringify(make(), null, 2) + '\n');
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(make(), v, 'the bytes on the wire are the golden ones');
    for (const p of v.packets) {
      const rx = p.role === 'host' ? L.deriveKeys(KEY, 'guest').rx : L.deriveKeys(KEY, 'host').rx;
      const got2 = L.open(rx, Buffer.from(p.wire, 'hex'));
      assert.strictEqual(got2.body.toString('hex'), p.body);
      assert.strictEqual(got2.seq, p.seq);
    }
  }

  console.log = quiet;
  clearInterval(keepAlive);
  console.log('inputlane: ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
