// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// #158: with Mouse and keyboard over Bluetooth on, cursor sharing rides the Bluetooth socket and the
// rest the network one; off, nothing of it is loaded and every message goes as before.
'use strict';
const assert = require('assert');
const B = require('../bleinput.js');

const sock = (transport, open = true) => { const s = { transport, readyState: open ? 1 : 3, OPEN: 1, out: [], send: (d) => s.out.push(JSON.parse(d).t) }; return s; };
const ip = sock('ip'), ble = sock('ble');
assert.strictEqual(B.route(ip, ble, { t: 'k.mm' }), ble);
assert.strictEqual(B.route(ip, ble, { t: 'kvm.take' }), ble);
assert.strictEqual(B.route(ip, ble, { t: 'file.chunk' }), ip);
assert.strictEqual(B.route(ble, ip, { t: 'clip.set' }), ip, 'Bluetooth the session’s main socket: the rest still on the network');
assert.strictEqual(B.route(ble, ip, { t: 'k.kd' }), ble);
assert.strictEqual(B.route(ip, null, { t: 'k.mm' }), ip, 'no Bluetooth socket: as before');
assert.strictEqual(B.route(ip, sock('ble', false), { t: 'k.mm' }), ip, 'Bluetooth closing: the network');
assert.strictEqual(B.route(sock('ble'), sock('ble'), { t: 'k.mm' }).transport, 'ble');
assert.ok(B.ready(ip, ble) && !B.ready(ip, null) && !B.ready(ble, null));

// The servers and links route only with it set; off they send on the session's socket as always.
// (A platform whose ws isn't installed here is skipped; CI installs it for all.)
const load = (m) => { try { return require(m); } catch (e) { if (/'ws'/.test(e.message)) { console.log('skip', m); return null; } throw e; } };
for (const p of ['mac', 'windows', 'linux']) {
  const mod = load(`../../${p}/server.js`);
  if (!mod) continue;
  const { Server } = mod;
  const s = Object.create(Server.prototype);
  const a = sock('ip'), b = sock('ble');
  const ctx = { ws: a, alt: b };
  s.send(ctx, { t: 'k.mm' });
  assert.deepStrictEqual([a.out, b.out], [['k.mm'], []], `${p} server off`);
  s.bleInput = B;
  s.send(ctx, { t: 'k.mm' }); s.send(ctx, { t: 'screen.offer' });
  assert.deepStrictEqual([a.out, b.out], [['k.mm', 'screen.offer'], ['k.mm']], `${p} server on`);
}
for (const p of ['windows', 'linux']) {
  const Link = load(`../../${p}/link.js`);
  if (!Link) continue;
  const L = Link.Link || Link;
  const l = Object.create(L.prototype);
  const a = sock('ip'), b = sock('ble');
  Object.assign(l, { authed: true, ws: a, alt: b });
  l.send({ t: 'k.kd' });
  assert.deepStrictEqual([a.out, b.out], [['k.kd'], []], `${p} link off`);
  l.bleInput = B;
  l.send({ t: 'k.kd' }); l.send({ t: 'clip.set' });
  assert.deepStrictEqual([a.out, b.out], [['k.kd', 'clip.set'], ['k.kd']], `${p} link on`);
}

// Multi-device: every session the same way (the servers' sessions and the Windows links; Linux's mesh
// has no Bluetooth with computers, docs/multi-device.md, so its links never get it).
for (const p of ['mac', 'windows', 'linux']) {
  const mod = load(`../../${p}/mesh/server.js`);
  if (!mod) continue;
  const s = Object.create((mod.Server || mod).prototype);
  s._now = Date.now; // set in its constructor
  const a = sock('ip'), b = sock('ble');
  const ctx = { ws: a, alt: b };
  s.send(ctx, { t: 'k.mm' });
  assert.deepStrictEqual([a.out, b.out], [['k.mm'], []], `${p} mesh server off`);
  s.bleInput = B;
  s.send(ctx, { t: 'k.mm' }); s.send(ctx, { t: 'screen.offer' });
  assert.deepStrictEqual([a.out, b.out], [['k.mm', 'screen.offer'], ['k.mm']], `${p} mesh server on`);
}
{
  const mod = load('../../windows/mesh/link.js');
  if (mod) {
    const L = mod.Link || mod;
    const l = Object.create(L.prototype);
    const a = sock('ip'), b = sock('ble');
    Object.assign(l, { authed: true, ws: a, alt: b });
    l.send({ t: 'k.kd' });
    assert.deepStrictEqual([a.out, b.out], [['k.kd'], []], 'windows mesh link off');
    l.bleInput = B;
    l.send({ t: 'k.kd' }); l.send({ t: 'clip.set' });
    assert.deepStrictEqual([a.out, b.out], [['k.kd', 'clip.set'], ['k.kd']], 'windows mesh link on');
    // Connecting again through Bluetooth: once when turned on, then at most every few minutes, and not
    // after its pipe just failed (it dials the network then).
    let again = 0;
    const m = Object.create(L.prototype);
    Object.assign(m, { authed: true, transport: 'ip', alt: null, pairing: { macId: 'mac', macName: 'Mac' }, ble: { get: () => ({ dev: 'd' }) },
      bleInput: B, bleAgainAt: 0, _connect: () => again++ });
    assert.ok(m.bleAgain() && again === 1, 'turned on: connects again through Bluetooth');
    assert.ok(!m.bleAgain() && again === 1, 'not again right away');
    m.bleAgainAt = 0; m.bleFailAt = Date.now();
    assert.ok(!m.bleAgain() && again === 1, 'its pipe just failed: stays on the network');
    m.bleFailAt = 0; m.alt = sock('ble');
    assert.ok(!m.bleAgain(), 'already has Bluetooth beside the network');
  }
}
for (const p of ['mac', 'windows', 'linux']) {
  const mod = load(`../../${p}/mesh/session.js`);
  if (!mod) continue;
  const S = mod.Session || mod;
  const lane = { started: true };
  const s = Object.create(S.prototype);
  s.link = { authed: true, transport: 'ip', ws: sock('ip'), alt: sock('ble'), ilLane: lane };
  assert.strictEqual(s.lane(), lane, `${p} mesh session: the input lane, off`);
  s.link.bleInput = B;
  assert.strictEqual(s.lane(), null, `${p} mesh session: input through Bluetooth, the lane steps aside`);
  s.link.alt = null;
  assert.strictEqual(s.lane(), lane, `${p} mesh session: no Bluetooth socket, the lane again`);
  const h = Object.create(S.prototype);
  h.link = null; h.ctx = { authed: true, transport: 'ip', ws: sock('ip'), alt: sock('ble'), ilLane: lane }; h.server = { bleInput: B };
  assert.strictEqual(h.lane(), null, `${p} mesh session we host: the lane steps aside`);
  h.server.bleInput = null;
  assert.strictEqual(h.lane(), lane, `${p} mesh session we host, off: the lane`);
}

// Nothing loads it unless the setting is on.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
for (const f of ['mac/server.js', 'windows/server.js', 'linux/server.js', 'windows/link.js', 'linux/link.js', 'mac/kvm.js', 'windows/kvm.js', 'linux/kvm.js',
  'mac/mesh/server.js', 'windows/mesh/server.js', 'linux/mesh/server.js', 'windows/mesh/link.js', 'mac/mesh/session.js', 'windows/mesh/session.js', 'linux/mesh/session.js']) {
  assert.ok(!/require\([^)]*bleinput/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} doesn't load it`);
}
for (const f of ['mac/peer.js', 'windows/peer.js', 'linux/peer.js']) {
  assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /const m = on \? require\('\.\.\/shared\/bleinput\.js'\) : null|this\.bleInput = on \? require\('\.\.\/shared\/bleinput\.js'\) : null/, `${f} loads it only when on`);
}
console.log('bleinput: routing on, nothing changed off');
