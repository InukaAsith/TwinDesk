// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/mesh-manage.js: a phone on computer A manages B (connected to A) and C (connected only to B),
// wakes an offline D that B knows, is refused once B revokes it, approves a pairing waiting on C, and
// arranges the layout through A.
// Run: node shared/test/mesh-manage.test.js
'use strict';

const assert = require('assert');
const { meshManage, STRONG } = require('../mesh-manage.js');

const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Computers A–B–C in a line; phone P on A. Each bus delivers what its device's links send it.
const net = { A: ['B', 'P'], B: ['A', 'C'], C: ['B'], P: ['A'] };
const buses = {};
function bus(id) {
  const h = new Map(); const peers = new Map();
  const b = {
    on: (t, fn) => { if (!h.has(t)) h.set(t, []); h.get(t).push(fn); },
    onPeer: (ev, fn) => { if (!peers.has(ev)) peers.set(ev, []); peers.get(ev).push(fn); },
    send: (to, msg) => { if (!net[id].includes(to)) return false; setImmediate(() => buses[to].deliver(msg, id)); return true; },
    deliver: (msg, from) => (h.get(msg.t) || []).forEach((fn) => fn(JSON.parse(JSON.stringify(msg)), from)),
    sent: [],
  };
  buses[id] = b;
  return b;
}
const phoneGot = [];

function computer(id, extra = {}) {
  const b = bus(id);
  const settings = {};
  const did = [];
  const pending = extra.pending ? { ...extra.pending } : null;
  const state = { pending };
  const m = meshManage({
    bus: b,
    mesh: { peers: () => net[id].filter((x) => x !== 'P').map((x) => ({ id: x, mesh: true, send: (msg) => b.send(x, msg) })) },
    selfId: id, name: () => 'PC-' + id, os: 'linux', settings: () => settings, save: () => {},
    isPhone: (x) => x === 'P', peerName: (x) => (x === 'P' ? 'Pixel' : x),
    devices: () => ['A', 'B', 'C', 'D'].filter((x) => x !== id).map((x) => ({ id: x, name: 'PC-' + x, os: 'win', online: x !== 'D' })),
    local: { can: () => ({ lock: true, sleep: true, restart: true, shutdown: true, ring: true }), do: async (act) => { did.push(act); } },
    wake: (x) => { if (extra.wakes && extra.wakes.includes(x)) { did.push('wol:' + x); return true; } return false; },
    wakes: () => extra.wakes || [],
    pairing: { pending: () => state.pending, respond: (allow) => { did.push(allow ? 'allow' : 'deny'); state.pending = null; }, forget: (x) => did.push('forget:' + x) },
    layout: extra.layout || null,
  });
  return { m, did, settings, state };
}

async function main() {
  const placed = [];
  const layout = { state: () => ({ cells: { A: { x: 0, y: 0 }, B: { x: 1, y: 0 } }, targets: { C: ['2,0'] } }), place: (d, x, y) => { placed.push([d, x, y]); return true; }, remove: () => true };
  const A = computer('A', { layout });
  const B = computer('B', { wakes: ['D'] });
  const C = computer('C', { pending: { name: 'New laptop', os: 'mac', code: '123456' } });
  const P = bus('P');
  P.on('mesh.view', (v) => phoneGot.push(v));
  P.on('mesh.done', (v) => phoneGot.push(v));
  const phoneSend = (msg) => buses.P.send('A', msg);
  for (const x of [A, B, C]) x.m.tick();
  await wait(20);

  // The phone asks: every computer, what it can do, C's pairing, D wakeable through B.
  phoneSend({ t: 'mesh.ask' });
  await wait(20);
  const v = phoneGot.filter((x) => x.t === 'mesh.view').pop();
  assert.ok(v, 'a view');
  assert.deepStrictEqual(v.devices.map((d) => d.id), ['A', 'B', 'C', 'D']);
  const byId = Object.fromEntries(v.devices.map((d) => [d.id, d]));
  assert.ok(byId.A.self && byId.C.can.restart && !byId.C.can.ring, 'C can restart, ring is not the manager\'s');
  assert.strictEqual(byId.C.pending.name, 'New laptop');
  assert.deepStrictEqual(byId.D.can, { wake: true }, 'D is offline: wake only, B knows it');
  assert.deepStrictEqual(v.layout.targets, { C: ['2,0'] });
  assert.deepStrictEqual(v.strong, STRONG);

  // Lock C, two hops away: relayed, done.
  phoneSend({ t: 'mesh.do', rid: 'r1', to: 'C', do: 'lock' });
  await wait(30);
  assert.deepStrictEqual(C.did, ['lock']);
  assert.deepStrictEqual(phoneGot.find((x) => x.rid === 'r1'), { t: 'mesh.done', rid: 'r1', ok: true });
  assert.strictEqual(C.settings.manage.seen.P, 'Pixel', 'C remembers the phone for its Phones list');

  // Wake D (offline): A doesn't know it, B does and sends the packet.
  phoneSend({ t: 'mesh.do', rid: 'r2', to: 'D', do: 'wake' });
  await wait(30);
  assert.ok(B.did.includes('wol:D'));
  assert.strictEqual(phoneGot.find((x) => x.rid === 'r2').ok, true);

  // Approve C's pairing.
  phoneSend({ t: 'mesh.do', rid: 'r3', to: 'C', do: 'approve' });
  await wait(30);
  assert.ok(C.did.includes('allow'));
  assert.strictEqual(phoneGot.find((x) => x.rid === 'r3').ok, true);

  // B revokes the phone: refused, nothing done there.
  B.m.setRevoked('P', true);
  phoneSend({ t: 'mesh.do', rid: 'r4', to: 'B', do: 'restart' });
  await wait(30);
  assert.deepStrictEqual(phoneGot.find((x) => x.rid === 'r4'), { t: 'mesh.done', rid: 'r4', ok: false, why: 'revoked' });
  assert.ok(!B.did.includes('restart'));
  assert.deepStrictEqual(B.m.pageView().phones, [{ id: 'P', name: 'P', revoked: true }]);

  // C turns the manager off: its row says so, the phone's next command is refused.
  C.m.setOn(false);
  await wait(30);
  phoneSend({ t: 'mesh.ask' });
  await wait(20);
  const v2 = phoneGot.filter((x) => x.t === 'mesh.view').pop();
  assert.strictEqual(v2.devices.find((d) => d.id === 'C').on, false);
  assert.deepStrictEqual(v2.devices.find((d) => d.id === 'C').can, {});
  phoneSend({ t: 'mesh.do', rid: 'r5', to: 'C', do: 'lock' });
  await wait(30);
  assert.strictEqual(phoneGot.find((x) => x.rid === 'r5').why, 'off');

  // The layout, through A.
  phoneSend({ t: 'mesh.do', rid: 'r6', to: 'A', do: 'place', dev: 'C', x: 2, y: 0 });
  await wait(20);
  assert.deepStrictEqual(placed, [['C', 2, 0]]);

  // Only a phone may ask: a computer's mesh.do is ignored.
  buses.B.send('A', { t: 'mesh.do', rid: 'r7', to: 'A', do: 'shutdown' });
  await wait(20);
  assert.ok(!A.did.includes('shutdown'));

  // Sleep waits for the answer to go out.
  phoneSend({ t: 'mesh.do', rid: 'r8', to: 'A', do: 'sleep' });
  await wait(30);
  assert.strictEqual(phoneGot.find((x) => x.rid === 'r8').ok, true);
  assert.ok(!A.did.includes('sleep'), 'not yet');
  await wait(1600);
  assert.ok(A.did.includes('sleep'));

  for (const x of [A, B, C]) x.m.stop();
  console.log('mesh-manage: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
