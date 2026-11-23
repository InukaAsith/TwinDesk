// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/mesh-graph.js and shared/mesh-shadow.js (docs/mesh-graph.md): the edges of a service, the input
// peer, randomized meshes against the rules, the November 2026 bugs as scenarios, and the shadow's lines.
// Run: node shared/test/mesh-graph.test.js
'use strict';

const assert = require('assert');
const { SERVICES, resolve, InputPeer } = require('../mesh-graph.js');
const { MeshShadow } = require('../mesh-shadow.js');

const active = (edges, from) => edges.filter((e) => e.stage === 'active' && (!from || e.from === from)).map((e) => e.to);
const edge = (edges, from, to) => edges.find((e) => e.from === from && e.to === to);

// ---- resolve ----

// Kinds: a phone can't take a microphone or open a terminal; a computer can't give phone calls.
{
  const nodes = [{ id: 'pc', os: 'linux' }, { id: 'ph', os: 'android' }, { id: 'mac', os: 'mac' }];
  const mic = resolve('mic', { nodes });
  assert.strictEqual(edge(mic, 'pc', 'ph').stage, 'candidate');
  assert.match(edge(mic, 'pc', 'ph').reason, /can't take it/);
  const phone = resolve('phone', { nodes });
  assert.strictEqual(edge(phone, 'pc', 'mac').stage, 'candidate');
  assert.match(edge(phone, 'pc', 'mac').reason, /can't give it/);
  assert.deepStrictEqual(active(phone, 'ph'), ['mac', 'pc'].slice(0, 1)); // perOut 1: the id decides a tie
  assert.throws(() => resolve('cursor', { nodes }), /no graph/);
}

// Switches: why an edge stops at candidate is the switch's own sentence.
{
  const nodes = [{ id: 'a', os: 'win' }, { id: 'b', os: 'win' }, { id: 'c', os: 'mac' }];
  const e = resolve('sound', { nodes, from: 'a', allowed: (svc, f, t) => (t === 'c' ? 'Send is off for it' : true) });
  assert.deepStrictEqual(active(e), ['b']);
  assert.strictEqual(edge(e, 'a', 'c').reason, 'Send is off for it');
  assert.ok(e.every((x) => x.from === 'a'), 'from: only that provider’s rows');
}

// Sound to several: every allowed edge, up to perOut, the rest pruned with where it goes.
{
  const nodes = [{ id: 'p', os: 'linux' }];
  for (let i = 0; i < 8; i++) nodes.push({ id: 'r' + i, os: 'win', name: 'R' + i });
  const e = resolve('sound', { nodes, from: 'p' });
  assert.strictEqual(active(e).length, SERVICES.sound.perOut);
  const pruned = e.filter((x) => x.stage === 'allowed');
  assert.strictEqual(pruned.length, 8 - SERVICES.sound.perOut);
  assert.match(pruned[0].reason, /^Sound from p goes to R0, R1/);
}

// Rank: pinned > input peer > selection > id.
{
  const nodes = ['me', 'a', 'b', 'c', 'd'].map((id) => ({ id, os: 'mac' }));
  const g = (o) => ({ nodes, from: 'me', ...o });
  assert.deepStrictEqual(active(resolve('mic', g({}))), ['a']);
  assert.deepStrictEqual(active(resolve('mic', g({ selected: () => 'c' }))), ['c']);
  assert.deepStrictEqual(active(resolve('mic', g({ selected: () => 'c', inputPeer: () => 'b' }))), ['b']);
  assert.deepStrictEqual(active(resolve('mic', g({ selected: () => 'c', inputPeer: () => 'b', pin: () => 'd' }))), ['d']);
}

// perIn: a receiver that two providers chose takes its own best one; the other edge says from whom.
{
  const nodes = [{ id: 'x', os: 'win', name: 'X' }, { id: 'y', os: 'win', name: 'Y' }, { id: 'v', os: 'linux', name: 'V' }];
  const e = resolve('mic', { nodes, inputPeer: (id) => (id === 'v' ? 'y' : id === 'x' || id === 'y' ? 'v' : null) });
  assert.strictEqual(edge(e, 'y', 'v').stage, 'active');
  assert.strictEqual(edge(e, 'x', 'v').stage, 'allowed');
  assert.strictEqual(edge(e, 'x', 'v').reason, 'V takes microphone from Y');
}

// ---- the input peer ----

{
  const p = new InputPeer({ dwellMs: 2000 });
  assert.strictEqual(p.note('driven', 'ryzen', 0), false, 'not before the dwell');
  assert.strictEqual(p.id, null);
  assert.strictEqual(p.note('driven', 'ryzen', 1999), false);
  assert.strictEqual(p.note('driven', 'ryzen', 2000), true);
  assert.strictEqual(p.id, 'ryzen');
  assert.strictEqual(p.why, 'it drives this computer');
  assert.strictEqual(p.note('home', null, 3000), false, 'home doesn’t clear it');
  assert.strictEqual(p.id, 'ryzen');
  // Passing through: the Mac for less than the dwell, then home.
  p.note('driven', 'mac', 4000);
  p.note('home', null, 5000);
  p.note('driven', 'mac', 9000); // a new visit starts its own dwell
  assert.strictEqual(p.id, 'ryzen');
  assert.strictEqual(p.note('driven', 'mac', 11000), true);
  assert.strictEqual(p.id, 'mac');
  // Driving another one: it's the input peer too.
  p.note('driving', 'amx', 12000);
  p.note('driving', 'amx', 14000);
  assert.strictEqual(p.id, 'amx');
  assert.strictEqual(p.why, 'this computer drives it');
  // A click counts at once; a device that leaves is forgotten.
  assert.strictEqual(p.take('ryzen', 'chosen'), true);
  assert.strictEqual(p.forget('amx'), false);
  assert.strictEqual(p.forget('ryzen'), true);
  assert.strictEqual(p.id, null);
  const now = new InputPeer({ dwellMs: 0 });
  assert.strictEqual(now.note('driven', 'a', 5), true, 'no dwell: at once');
}

// ---- randomized meshes against the rules ----

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const OSES = ['mac', 'win', 'linux', 'android', 'ios'];
const GRAPH = Object.keys(SERVICES).filter((k) => !SERVICES[k].own);

for (let seed = 1; seed <= 400; seed++) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const n = 1 + Math.floor(r() * 8);
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push({ id: 'd' + Math.floor(r() * 1e6).toString(36) + i, os: pick(OSES) });
  const ids = nodes.map((x) => x.id);
  const off = new Set();
  for (const a of ids) for (const b of ids) if (r() < 0.25) off.add(a + '>' + b);
  const ip = {}, sel = {}, pin = {};
  for (const id of ids) {
    if (r() < 0.6) ip[id] = pick(ids);
    if (r() < 0.8) sel[id] = pick(ids);
    if (r() < 0.15) pin[id] = pick(ids);
  }
  const g = {
    nodes,
    allowed: (svc, f, t) => (off.has(f + '>' + t) ? 'switched off' : true),
    inputPeer: (id) => ip[id] || null,
    selected: (id) => sel[id] || null,
    pin: (id) => pin[id] || null,
  };
  const svc = pick(GRAPH);
  const s = SERVICES[svc];
  const e = resolve(svc, g);
  const ctx = `seed ${seed} ${svc}`;

  assert.strictEqual(e.length, n * (n - 1), ctx + ': every pair, both ways');
  for (const x of e) {
    // Nothing active that isn't allowed: the kinds and the switches.
    if (x.stage !== 'candidate') {
      assert.ok(s.from.includes(nodes.find((k) => k.id === x.from).os) && s.to.includes(nodes.find((k) => k.id === x.to).os), ctx + ': kinds');
      assert.ok(!off.has(x.from + '>' + x.to), ctx + ': switches');
    } else assert.ok(x.reason, ctx + ': a candidate says why');
    if (x.stage === 'allowed') assert.ok(x.reason, ctx + ': a pruned edge says why');
  }
  for (const id of ids) {
    const out = e.filter((x) => x.from === id && x.stage === 'active');
    const into = e.filter((x) => x.to === id && x.stage === 'active');
    assert.ok(out.length <= s.perOut, ctx + ': perOut');
    assert.ok(into.length <= s.perIn, ctx + ': perIn');
    // A provider keeps as many as it may, when no receiver turned it down.
    const allowedOut = e.filter((x) => x.from === id && x.stage !== 'candidate');
    if (!Number.isFinite(s.perIn)) assert.strictEqual(out.length, Math.min(s.perOut, allowedOut.length), ctx + ': kept all it may');
    // The input peer outranks the selection: with one to give, an allowed input peer (not pinned past) gets it.
    if (s.perOut === 1 && ip[id] && ip[id] !== id && !pin[id]) {
      const toPeer = e.find((x) => x.from === id && x.to === ip[id]);
      if (toPeer.stage !== 'candidate' && sel[id] !== ip[id]) {
        const lostTo = e.find((x) => x.from === id && x.stage === 'active');
        if (lostTo) assert.notStrictEqual(lostTo.to, sel[id], ctx + ': the selection never beats an allowed input peer');
      }
    }
  }
  // The same inputs give the same edges, whatever order the nodes come in.
  const again = resolve(svc, { ...g, nodes: nodes.slice().reverse() });
  assert.deepStrictEqual(again, e, ctx + ': deterministic');
  // A device computing only its own rows agrees with the whole graph on them (perIn aside).
  if (!Number.isFinite(s.perIn)) {
    for (const id of ids) {
      assert.deepStrictEqual(resolve(svc, { ...g, from: id }), e.filter((x) => x.from === id), ctx + ': own rows');
    }
  }
}

// ---- scenarios: November 2026 ----

const NITRO = { id: 'b87c', os: 'linux', name: 'nitro5' };
const RYZEN = { id: '6289', os: 'win', name: 'Ryzen9' };
const AMX = { id: '48a3', os: 'win', name: 'AMXLPDL-47H-169' };
const MAC = { id: '788f', os: 'mac', name: 'MacBook-Air-de-Ortega' };

// The Mac connects first (selected), Ryzen9 takes nitro over: after the dwell nitro's microphone goes to
// Ryzen9, not to the selected Mac.
{
  const p = new InputPeer();
  p.note('driven', RYZEN.id, 0);
  p.note('driven', RYZEN.id, 2500);
  const e = resolve('mic', { nodes: [NITRO, RYZEN, AMX, MAC], from: NITRO.id, selected: () => MAC.id, inputPeer: () => p.id });
  assert.deepStrictEqual(active(e), [RYZEN.id]);
  assert.match(edge(e, NITRO.id, MAC.id).reason, /^Microphone from nitro5 goes to Ryzen9$/);
}

// nitro's sound to every device whose switch is on, without any of them having nitro selected; the Mac's
// switch off says so.
{
  const e = resolve('sound', { nodes: [NITRO, RYZEN, AMX, MAC], from: NITRO.id, selected: () => AMX.id, allowed: (svc, f, t) => (t === MAC.id ? 'Send is off for it' : true) });
  assert.deepStrictEqual(active(e).sort(), [AMX.id, RYZEN.id].sort());
  assert.strictEqual(edge(e, NITRO.id, MAC.id).reason, 'Send is off for it');
}

// ---- the shadow ----

{
  const lines = [];
  let t = 0;
  const sessions = [RYZEN, MAC].map((d) => ({ id: d.id, connected: true, peerOs: d.os, displayName: () => d.name }));
  const hub = { device: { id: NITRO.id, name: NITRO.name }, selectedId: MAC.id, sessions: { list: () => sessions } };
  const kvm = { mode: 'home', partner: null };
  const sound = { link: { current: { deviceId: MAC.id } }, status: { sending: false } };
  // The Mac is selected: its switches are settings.audio itself (pairFor); Ryzen9's are its pair's.
  const settings = { audio: { send: false, micSend: false }, pairSync: { [RYZEN.id]: { audio: { out: true, in: false } } } };
  const sh = new MeshShadow({ hub, kvm: () => kvm, sound: () => sound, mic: () => null, settings: () => settings, log: (l) => lines.push(l), now: () => t, os: 'linux' });

  sh.tick();
  assert.deepStrictEqual(lines, [
    '[graph] input peer: nobody yet',
    '[graph] sound: would Ryzen9 (MacBook-Air-de-Ortega: Send is off for it) | does MacBook-Air-de-Ortega, not sending',
    '[graph] mic: would nobody (Ryzen9: Send microphone is off; MacBook-Air-de-Ortega: Send microphone is off) | does nothing (the microphone isn’t on)',
    '[graph] name: would MacBook-Air-de-Ortega (the selection) | does MacBook-Air-de-Ortega (the selection)',
  ]);
  lines.length = 0;
  sh.tick();
  assert.deepStrictEqual(lines, [], 'nothing changed: nothing logged');

  // Ryzen9 takes nitro over: after the dwell the input peer and the name move to it.
  Object.assign(kvm, { mode: 'driven', partner: RYZEN.id });
  sh.tick();
  t = 2500;
  sh.tick();
  assert.deepStrictEqual(lines, [
    '[graph] input peer: Ryzen9 (it drives this computer)',
    '[graph] name: would Ryzen9 (the input peer) | does MacBook-Air-de-Ortega (the selection)',
  ]);

  // Ryzen9 leaves: forgotten.
  lines.length = 0;
  sessions.shift();
  sh.tick();
  assert.ok(lines.includes('[graph] input peer: nobody yet'));

  // A shadow that breaks says so once and never throws into the app.
  lines.length = 0;
  hub.sessions.list = () => { throw new Error('boom'); };
  sh.tick();
  sh.tick();
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^\[graph\] shadow stopped logging: Error: boom/);
}

console.log('mesh-graph: all passed');
