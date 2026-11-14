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

// Nothing loads it unless the setting is on.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
for (const f of ['mac/server.js', 'windows/server.js', 'linux/server.js', 'windows/link.js', 'linux/link.js', 'mac/kvm.js', 'windows/kvm.js', 'linux/kvm.js']) {
  assert.ok(!/require\([^)]*bleinput/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} doesn't load it`);
}
for (const f of ['mac/peer.js', 'windows/peer.js', 'linux/peer.js']) {
  assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /const m = on \? require\('\.\.\/shared\/bleinput\.js'\) : null|this\.bleInput = on \? require\('\.\.\/shared\/bleinput\.js'\) : null/, `${f} loads it only when on`);
}
console.log('bleinput: routing on, nothing changed off');
