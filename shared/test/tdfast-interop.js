// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The native lane (native/tdfast, docs/perf-plan.md P3) and the JS lane (shared/inputlane.js) on real UDP:
// a P2 peer and a P3 peer interoperate. Moves both ways come out exact under 30% loss; events carry
// their es and a move waits for the event before it. Needs the example peer built:
//   cargo build --release --example peer   (in native/tdfast); skipped without it.
// Run with: node shared/test/tdfast-interop.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'native', 'tdfast', 'target', 'release', 'examples', process.platform === 'win32' ? 'peer.exe' : 'peer');
if (!fs.existsSync(BIN)) {
  console.log('tdfast-interop: skipped (build native/tdfast\'s example peer first)');
  process.exit(0);
}

const until = async (cond, what, ms = 10000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Rust peer: commands in, callbacks out ({ev, …}).
function rustPeer(loss) {
  const p = spawn(BIN, [], { env: { ...process.env, TWINDESK_LANE_LOSS: String(loss) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const peer = { p, got: [], cmd: (o) => p.stdin.write(`${JSON.stringify(o)}\n`) };
  readline.createInterface({ input: p.stdout }).on('line', (l) => peer.got.push(JSON.parse(l)));
  peer.last = (ev) => peer.got.filter((x) => x.ev === ev).slice(-1)[0];
  return peer;
}

async function pairUp(loss) {
  process.env.TWINDESK_LANE_LOSS = String(loss);
  delete require.cache[require.resolve('../inputlane.js')];
  const L = require('../inputlane.js');
  const js = new L.InputLane();
  await js.bind();
  const rust = rustPeer(loss);
  rust.cmd({ op: 'bind' });
  await until(() => rust.last('port'), 'the rust port');
  const offer = js.offer({ v: 1, port: rust.last('port').port }, '127.0.0.1'); // JS is the host
  assert.ok(offer && /^[0-9a-f]{64}$/.test(offer.key));
  rust.cmd({ op: 'start', role: 'guest', key: offer.key, ip: '127.0.0.1', port: offer.port });
  await until(() => rust.last('started'), 'started');
  assert.strictEqual(rust.last('started').ok, 1);
  await until(() => js.up && rust.last('up'), 'both up');
  js.active(true);
  rust.cmd({ op: 'active', on: true });
  return { L, js, rust };
}

(async () => {
  // 1. 30% loss: moves both ways, exact.
  {
    const { L, js, rust } = await pairUp(0.3);
    // JS drives, Rust is driven (speed 2).
    rust.cmd({ op: 'driven', route: 1, speed: 2 });
    await sleep(20);
    const t = new L.MoveTotals();
    t.reset(1);
    let sx = 0, sy = 0;
    for (let i = 0; i < 400; i++) {
      const dx = (i % 9) - 4, dy = (i % 5) - 2;
      sx += dx; sy += dy;
      js.sendMove(t.add(dx, dy));
      if (i % 20 === 0) await sleep(3);
    }
    const sum = () => rust.got.filter((x) => x.ev === 'move').reduce((a, x) => [a[0] + x.dx, a[1] + x.dy], [0, 0]);
    await until(() => { const s = sum(); return s[0] === sx * 2 && s[1] === sy * 2; }, 'the rust side ends where JS moved it (speed 2)');
    // Rust drives, JS is driven.
    const ma = new L.MoveApply();
    ma.reset(7);
    let jx = 0, jy = 0;
    js.on('move', (s) => { const d = ma.take(s); if (d) { jx += d.dx; jy += d.dy; } });
    rust.cmd({ op: 'drive', route: 7 });
    let rx = 0, ry = 0;
    for (let i = 0; i < 400; i++) {
      const dx = (i % 7) - 3, dy = (i % 3) - 1;
      rx += dx; ry += dy;
      rust.cmd({ op: 'move', dx, dy });
      if (i % 20 === 0) await sleep(3);
    }
    await until(() => jx === rx && jy === ry, 'the JS side ends where Rust moved it');
    rust.p.kill();
    js.close();
  }

  // 2. No loss: events with es; a move waits for the event named in it.
  {
    const { L, js, rust } = await pairUp(0);
    rust.cmd({ op: 'driven', route: 3, speed: 1 });
    await sleep(20);
    const t = new L.MoveTotals();
    t.reset(3);
    js.sendMove(t.add(5, 0));
    await until(() => rust.got.some((x) => x.ev === 'move' && x.dx === 5), 'the first move');
    const es = js.nextEs();
    t.es = es;
    js.sendEvent({ t: 'k.md', b: 0, es });
    js.sendMove({ ...t.add(1, 1), es });
    await until(() => rust.last('event'), 'the event');
    assert.deepStrictEqual(rust.last('event').msg, { es: 1, t: 'k.md', b: 0 });
    await sleep(60);
    assert.ok(!rust.got.some((x) => x.ev === 'move' && x.dx === 1), 'the move after the click waits for it');
    rust.cmd({ op: 'done', es: 1 }); // the helper injected the click
    await until(() => rust.got.some((x) => x.ev === 'move' && x.dx === 1 && x.dy === 1), 'then it goes');
    // A WSS fence (the lane copy lost): applied once, not twice.
    rust.cmd({ op: 'fence', route: 3, mn: 3, cx: 10, cy: 1 });
    await until(() => rust.got.some((x) => x.ev === 'move' && x.fence && x.dx === 4), 'the fence moves the rest of the way');
    rust.cmd({ op: 'fence', route: 3, mn: 3, cx: 10, cy: 1 });
    await sleep(30);
    assert.strictEqual(rust.got.filter((x) => x.fence).length, 1, 'an old fence moves nothing');
    // Rust's events reach JS with their es.
    const evs = [];
    js.on('event', (m) => evs.push(m));
    rust.cmd({ op: 'drive', route: 4 });
    rust.cmd({ op: 'event', json: JSON.stringify({ t: 'k.kd', code: 'KeyQ' }) });
    await until(() => evs.length >= 1, 'the rust event');
    assert.deepStrictEqual(evs[0], { t: 'k.kd', code: 'KeyQ', es: 1 });
    const f = rust.last('fenced');
    assert.deepStrictEqual([f.es, f.route, f.mn], [1, 4, 0]);
    // The peer goes silent: the lane goes down.
    rust.p.kill();
    await until(() => !js.up, 'down after 3 intervals', 5000);
    js.close();
  }

  // 3. Direct: the driven helper injects clicks and wheel from the lane itself, in order, once.
  {
    const { L, js, rust } = await pairUp(0);
    rust.cmd({ op: 'driven', route: 5, speed: 1 });
    rust.cmd({ op: 'direct', on: true, reverse: true });
    await sleep(20);
    const t = new L.MoveTotals();
    t.reset(5);
    const fenced = (msg) => {
      const c = t.current();
      const es = js.nextEs();
      t.es = es;
      return { ...msg, es, route: c.route, mn: c.mn, mc: [c.cx, c.cy] };
    };
    js.sendMove(t.add(4, 0));
    await until(() => rust.got.some((x) => x.ev === 'move' && x.dx === 4), 'the first move');
    t.add(3, 0); // a move whose packet never went: the click's fence takes the pointer there first
    js.sendEvent(fenced({ t: 'k.md', b: 0 }));
    await until(() => rust.last('button'), 'the click, injected by the lane');
    const i = rust.got.findIndex((x) => x.ev === 'button');
    assert.deepStrictEqual(rust.got[i - 1], { ev: 'move', dx: 3, dy: 0 }, 'its fence moves first');
    assert.deepStrictEqual(rust.got[i], { ev: 'button', b: 0, down: true });
    await until(() => rust.last('event') && rust.last('event').msg.es === 1, 'Node still hears of it');
    rust.cmd({ op: 'claim', es: 1 });
    await until(() => rust.last('claim'), 'claim 1');
    assert.strictEqual(rust.last('claim').new, false, 'the WSS copy finds it taken');
    js.sendEvent(fenced({ t: 'k.wh', dx: 0, dy: 2, mode: 'line' }));
    await until(() => rust.last('wheel'), 'the wheel step');
    assert.deepStrictEqual(rust.last('wheel'), { ev: 'wheel', dx: -0, dy: -2, line: true }, 'reversed');
    // A key goes through Node (its layout): not injected here; Node's inject claims it.
    js.sendEvent(fenced({ t: 'k.kd', code: 'KeyA' }));
    await until(() => rust.last('event').msg.es === 3, 'the key, to Node');
    rust.cmd({ op: 'claim', es: 3 });
    await until(() => rust.last('claim').es === 3, 'claim 3');
    assert.strictEqual(rust.last('claim').new, true);
    // A click behind a gap (es 5 before 4) waits for Node, which keeps the order.
    const e4 = fenced({ t: 'k.kd', code: 'KeyB' });
    js.sendEvent(fenced({ t: 'k.mu', b: 0 })); // es 5, sent before es 4
    await until(() => rust.last('event').msg.es === 5, 'the early click, to Node');
    assert.strictEqual(rust.got.filter((x) => x.ev === 'button').length, 1, 'not injected out of order');
    js.sendEvent(e4);
    await until(() => rust.last('event').msg.es === 4, 'the key before it');
    rust.cmd({ op: 'claim', es: 4 });
    rust.cmd({ op: 'claim', es: 5 });
    await until(() => rust.last('claim').es === 5, 'claim 5');
    assert.strictEqual(rust.last('claim').new, true, 'Node injects the click, in order');
    // Off (a drag from the other computer, or Node said so): everything goes to Node.
    rust.cmd({ op: 'direct', on: false, reverse: false });
    await sleep(20);
    js.sendEvent(fenced({ t: 'k.md', b: 1 }));
    await until(() => rust.last('event').msg.es === 6, 'the click, to Node');
    await sleep(30);
    assert.strictEqual(rust.got.filter((x) => x.ev === 'button').length, 1, 'not injected while off');
    rust.p.kill();
    js.close();
  }
  console.log('tdfast-interop: ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
