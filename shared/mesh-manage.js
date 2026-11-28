// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The mesh manager (phase 3 of the 2026-11-28 plan): a phone sees every computer of the mesh, not only the
// one it's connected to, and can wake, lock, unlock (Full KVM), sleep, restart or shut down any of them,
// approve a pairing waiting on one, remove a device, and arrange the layout. Each computer may turn this
// off, or revoke one phone (Multi-device › Phones), and the phone asks for its fingerprint before the
// strong actions (STRONG). On by default: it only answers what a paired phone asks.
//
// A phone has one link, to the computer it's connected to; that computer relays. Every computer tells the
// others what it can do (a Pool, `mesh.dev`, relayed as the layout is), so the phone's computer can show
// the whole mesh; a command for another computer goes out in the pool as `mesh.cmd {to, do, phone}` and
// comes back as `mesh.res {to: origin, rid, ok, why}`. A computer that's off can't answer: `wake` is sent
// by every computer that knows its network address (shared Wake), the phone's first.
//
// On the phone's link:
//   mesh.ask  {}                          ← phone: send me the view (now, and on every change for ASK_MS)
//   mesh.view {me, devices, layout}       → phone
//   mesh.do   {rid, to, do, dev?, x?, y?} ← phone
//   mesh.done {rid, ok, why?}             → phone (why: off, revoked, cant, nothing, timeout, unknown)
//
//   meshManage({ bus, mesh, selfId, name(), os, settings() (its .manage), save(), isPhone(id),
//     peerName(id), devices() → [{id, name, os, online}] (the other computers, connected or known),
//     local: {can() → {lock, sleep, restart, shutdown, unlock}, do(act) → Promise},
//     wake(id) → bool (sent), wakes() → [ids it can wake],
//     pairing: {pending() → {name, os, code} | null, respond(allow), forget(id)},
//     layout: {state() → {cells, targets}, place(id, x, y), remove(id)} | null, onChange() })
//   tick()              with every state push: publish ours when it changed (and every minute)
//   view()              what the phone gets (also for tests)
//   pageView()          Multi-device › Phones: {on, phones: [{id, name, revoked}]}
//   setOn(on), setRevoked(id, revoked)
'use strict';

const { Pool } = require('./mesh.js');

const T = { ASK: 'mesh.ask', VIEW: 'mesh.view', DO: 'mesh.do', DONE: 'mesh.done', DEV: 'mesh.dev', CMD: 'mesh.cmd', RES: 'mesh.res' };
const POWER = ['lock', 'sleep', 'restart', 'shutdown', 'unlock'];
const ACTS = ['wake', ...POWER, 'approve', 'deny', 'remove', 'place'];
const STRONG = ['unlock', 'restart', 'shutdown', 'approve', 'remove']; // the phone asks for the fingerprint first
const REPUBLISH_MS = 60000;
const ASK_MS = 90000; // a phone that asked hears changes this long (it asks again while its page is open)
const REPLY_MS = 8000; // no mesh.res by then: an older TwinDesk there, or it went
const AFTER_MS = 1500; // sleep, restart, shut down: after the answer has gone out
const MAX = 32;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

function cleanCan(c) {
  const out = {};
  if (c && typeof c === 'object') for (const k of POWER) if (c[k] === true) out[k] = true;
  return out;
}

function cleanPending(p) {
  if (!p || typeof p !== 'object' || !str(p.name, 64)) return null;
  return { name: str(p.name, 64), os: str(p.os, 10), code: str(p.code, 12) };
}

class MeshManage {
  constructor(o) {
    Object.assign(this, { layout: null, pairing: null, wakes: () => [], onChange: () => {} }, o);
    this.pool = new Pool({ name: 'manage', selfId: this.selfId, peers: () => this._peers() });
    this.by = new Map(); // computer id -> {on, can, pending, wakes, at}
    this.watchers = new Map(); // phone id -> when it last asked
    this.waiting = new Map(); // rid -> {phone, timer}
    this.sentKey = '';
    this.sentAt = 0;
    this.viewKey = new Map(); // phone id -> the last view sent
    this.bus.on(T.DEV, (m, from) => this._heardDev(m, from));
    this.bus.on(T.CMD, (m, from) => this._heardCmd(m, from));
    this.bus.on(T.RES, (m, from) => this._heardRes(m, from));
    this.bus.on(T.ASK, (m, from) => this._asked(from));
    this.bus.on(T.DO, (m, from) => this._do(m || {}, from));
    this.bus.onPeer('welcome', () => { this.sentKey = ''; this.tick(); });
    this.bus.onPeer('closed', (id) => { this.watchers.delete(id); this.viewKey.delete(id); this.push(); });
  }

  get cfg() {
    const s = this.settings();
    if (!s.manage || typeof s.manage !== 'object') s.manage = {};
    const m = s.manage;
    if (typeof m.on !== 'boolean') m.on = true;
    if (!m.revoked || typeof m.revoked !== 'object') m.revoked = {};
    if (!m.seen || typeof m.seen !== 'object') m.seen = {};
    return m;
  }

  _peers() {
    return this.mesh.peers().filter((e) => e.mesh && !this.isPhone(e.id)).map((e) => ({ id: e.id, mesh: true, pool: true, send: (msg) => e.send(msg) }));
  }

  _mine() {
    const on = this.cfg.on;
    const p = this.pairing && this.pairing.pending();
    return { on, can: on ? cleanCan(this.local.can()) : {}, pending: on ? cleanPending(p) : null, wakes: (this.wakes() || []).slice(0, MAX) };
  }

  tick() {
    const ours = this._mine();
    const key = JSON.stringify(ours);
    if (key !== this.sentKey || Date.now() - this.sentAt >= REPUBLISH_MS) {
      const changed = key !== this.sentKey;
      this.sentKey = key;
      this.sentAt = Date.now();
      this.pool.publish({ t: T.DEV, ...ours });
      if (changed) this.push();
    }
  }

  _heardDev(m, from) {
    const r = this.pool.receive(from, m);
    if (!r.fresh || !r.msg || typeof r.msg.o !== 'string' || r.msg.o === this.selfId) return;
    this.by.set(r.msg.o, { on: m.on !== false, can: cleanCan(m.can), pending: cleanPending(m.pending), wakes: Array.isArray(m.wakes) ? m.wakes.filter((x) => typeof x === 'string').slice(0, MAX) : [], at: Date.now() });
    this.push();
  }

  // ---- the phone's side ----

  _asked(from) {
    if (!this.isPhone(from)) return;
    this.watchers.set(from, Date.now());
    this.viewKey.delete(from);
    this._send(from);
  }

  // Every phone still looking gets the view again when it changed.
  push() {
    const now = Date.now();
    for (const [id, at] of this.watchers) {
      if (now - at > ASK_MS) { this.watchers.delete(id); this.viewKey.delete(id); continue; }
      this._send(id);
    }
    this.onChange();
  }

  _send(phone) {
    const v = this.view();
    const k = JSON.stringify(v);
    if (this.viewKey.get(phone) === k) return;
    this.viewKey.set(phone, k);
    this.bus.send(phone, { t: T.VIEW, ...v });
  }

  view() {
    const mine = this._mine();
    const others = (this.devices() || []).filter((d) => d && d.id && d.id !== this.selfId && !this.isPhone(d.id)).slice(0, MAX);
    const wakers = new Set(mine.wakes);
    for (const s of this.by.values()) for (const id of s.wakes) wakers.add(id);
    const devices = [{ id: this.selfId, name: this.name(), os: this.os, self: true, online: true, on: mine.on, said: true, can: mine.can, pending: mine.pending }];
    for (const d of others) {
      const s = this.by.get(d.id);
      const can = d.online && s && s.on ? { ...s.can } : {};
      if (!d.online && wakers.has(d.id)) can.wake = true;
      devices.push({ id: d.id, name: str(d.name, 64) || d.id.slice(0, 8), os: str(d.os, 10), self: false, online: !!d.online, on: s ? s.on : true, said: !!s, can, pending: d.online && s && s.on ? s.pending : null });
    }
    let layout = null;
    if (this.layout) {
      try {
        const st = this.layout.state();
        layout = { cells: st.cells || {}, targets: st.targets || {} };
      } catch (_) { layout = null; }
    }
    return { me: this.selfId, devices, layout, strong: STRONG };
  }

  _reply(phone, rid, ok, why) {
    this.bus.send(phone, { t: T.DONE, rid, ok: !!ok, ...(why ? { why } : {}) });
  }

  async _do(m, from) {
    if (!this.isPhone(from)) return;
    const rid = str(m.rid, 40);
    const act = m.do;
    const to = str(m.to, 64);
    if (!ACTS.includes(act) || !to) return this._reply(from, rid, false, 'unknown');
    const phone = { id: from, name: str(this.peerName(from), 64) };
    const args = { dev: str(m.dev, 64), x: Number(m.x), y: Number(m.y) };
    // The layout is the mesh's: the phone's computer edits it, the pool carries it to the rest.
    if (act === 'place') {
      if (!this.layout || !this.layout.place(args.dev, args.x, args.y)) return this._reply(from, rid, false, 'cant');
      this.push();
      return this._reply(from, rid, true);
    }
    if (to === this.selfId) {
      const r = await this._run(act, args, phone);
      return this._reply(from, rid, r.ok, r.why);
    }
    if (act === 'remove' && to === '*') { // every computer forgets it, this one too
      const r = await this._run(act, args, phone);
      this.pool.publish({ t: T.CMD, to, do: act, dev: args.dev, phone });
      if (this.layout) try { this.layout.remove(args.dev); } catch (_) { /* not on it */ }
      return this._reply(from, rid, r.ok, r.why);
    }
    const d = (this.devices() || []).find((x) => x.id === to);
    if (act === 'wake' && !(d && d.online)) {
      const sent = this.wake(to); // ours first; the others that know it too
      this.pool.publish({ t: T.CMD, to, do: 'wake', phone });
      return this._reply(from, rid, sent || [...this.by.values()].some((s) => s.wakes.includes(to)), sent ? '' : 'nothing');
    }
    if (!d || !d.online) return this._reply(from, rid, false, 'offline');
    const timer = setTimeout(() => { this.waiting.delete(rid); this._reply(from, rid, false, 'timeout'); }, REPLY_MS);
    this.waiting.set(rid, { phone: from, timer });
    this.pool.publish({ t: T.CMD, to, do: act, rid, dev: args.dev, phone });
  }

  // ---- the computers' side ----

  _heardCmd(m, from) {
    const r = this.pool.receive(from, m);
    if (!r.fresh || !r.msg || r.msg.o === this.selfId) return;
    const phone = { id: str(m.phone && m.phone.id, 64), name: str(m.phone && m.phone.name, 64) };
    if (!phone.id) return;
    if (m.do === 'wake') { if (m.to !== this.selfId) this.wake(m.to); return; }
    if (m.to === '*' && m.do === 'remove') { this._run('remove', { dev: str(m.dev, 64) }, phone); return; }
    if (m.to !== this.selfId) return;
    this._run(m.do, { dev: str(m.dev, 64) }, phone).then((res) => {
      this.pool.publish({ t: T.RES, to: r.msg.o, rid: str(m.rid, 40), ok: res.ok, ...(res.why ? { why: res.why } : {}) });
    });
  }

  _heardRes(m, from) {
    const r = this.pool.receive(from, m);
    if (!r.fresh || !r.msg || m.to !== this.selfId) return;
    const w = this.waiting.get(str(m.rid, 40));
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(m.rid);
    this._reply(w.phone, m.rid, m.ok === true, str(m.why, 20));
  }

  // One action here, for a phone (its own or relayed). {ok, why}
  async _run(act, args, phone) {
    const cfg = this.cfg;
    if (!cfg.on) return { ok: false, why: 'off' };
    if (cfg.revoked[phone.id]) return { ok: false, why: 'revoked' };
    if (phone.name && cfg.seen[phone.id] !== phone.name) { cfg.seen[phone.id] = phone.name; this.save(); this.onChange(); }
    console.log('[manage] ' + act + (args.dev ? ' ' + args.dev.slice(0, 8) : '') + ' from ' + (phone.name || phone.id.slice(0, 8)));
    if (POWER.includes(act)) {
      if (!cleanCan(this.local.can())[act]) return { ok: false, why: 'cant' };
      const go = () => Promise.resolve(this.local.do(act)).catch((e) => console.log('[manage] ' + act + ': ' + e.message));
      if (act === 'lock' || act === 'unlock') await go();
      else setTimeout(go, AFTER_MS);
      return { ok: true };
    }
    if (act === 'approve' || act === 'deny') {
      if (!this.pairing || !this.pairing.pending()) return { ok: false, why: 'nothing' };
      this.pairing.respond(act === 'approve');
      return { ok: true };
    }
    if (act === 'remove') {
      if (!args.dev || args.dev === this.selfId || !this.pairing) return { ok: false, why: 'cant' };
      this.pairing.forget(args.dev);
      return { ok: true };
    }
    return { ok: false, why: 'unknown' };
  }

  // ---- Multi-device › Phones ----

  pageView() {
    const cfg = this.cfg;
    const ids = [...new Set([...Object.keys(cfg.seen), ...Object.keys(cfg.revoked)])].slice(0, MAX);
    return { on: cfg.on, phones: ids.map((id) => ({ id, name: cfg.seen[id] || cfg.revoked[id] || id.slice(0, 8), revoked: !!cfg.revoked[id] })) };
  }

  setOn(on) {
    this.cfg.on = !!on;
    this.save();
    this.tick();
    this.onChange();
  }

  setRevoked(id, revoked) {
    if (typeof id !== 'string' || !id) return;
    const cfg = this.cfg;
    if (revoked) cfg.revoked[id] = cfg.seen[id] || id.slice(0, 8);
    else delete cfg.revoked[id];
    this.save();
    this.onChange();
  }

  stop() {
    for (const w of this.waiting.values()) clearTimeout(w.timer);
    this.waiting.clear();
  }
}

// The local actions from this computer's DevLocal (shared/devlocal.js): Overview's lock and sleep, and the
// power actions only the manager has.
function localFrom(devLocal, fullKvm = () => false) {
  return {
    can: () => ({ ...devLocal.can(), ...devLocal.powerCan({ fullKvm: fullKvm() }) }),
    do: (act) => (act === 'lock' || act === 'sleep' ? devLocal.do({ do: act }) : devLocal.power(act)),
  };
}

// Windows, Linux and the Mac: the manager from a mesh hub (*/mesh/hub.js) and this computer's parts.
//   wake: the platform's Wake (wake(id), and settings.wake.peers: the computers it learned to wake)
//   layout(): layout-sync.js once made (null before)
function onHub({ hub, mesh, selfId, name, os, settings, save, devLocal, wake, layout, onChange }) {
  const P = require('./protocol.js');
  const peer = (id) => (hub.sessions && hub.sessions.get(id)) || null;
  const isPhone = (id) => { const s = peer(id); return !!s && P.isPhoneOs(s.peerOs); };
  const list = () => hub.peers({ indirect: true }); // the Mac's lists the indirect ones always
  return new MeshManage({
    bus: hub.bus, mesh, selfId, name, os, settings, save, isPhone, onChange,
    peerName: (id) => { const s = peer(id); return s ? (s.displayName ? s.displayName() : s.name) : ''; },
    devices: () => list().filter((d) => !P.isPhoneOs(d.os)).map((d) => ({ id: d.id, name: d.name, os: d.os, online: !!d.connected || d.state === 'via' })),
    local: localFrom(devLocal, () => require('./edition.js').fullKvm()),
    wake: (id) => !!(wake() && wake().wake(id)),
    wakes: () => Object.keys(((settings().wake || {}).peers) || {}),
    pairing: {
      pending: () => { const p = hub.pairing && hub.pairing.pendingView(); return p && p.code && !p.allowed ? p : null; },
      respond: (allow) => hub.respondPair(allow),
      forget: (id) => hub.forgetPeer(id),
    },
    layout: { state: () => layout().state(), place: (id, x, y) => !!layout() && layout().place(id, x, y), remove: (id) => !!layout() && layout().remove(id) },
  });
}

module.exports = { MeshManage, meshManage: (o) => new MeshManage(o), onHub, localFrom, T, ACTS, STRONG };
