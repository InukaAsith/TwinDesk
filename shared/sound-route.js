// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Sound routing per edge (Audio › the mixer): on which of a computer's speakers another computer's
// sound plays, and how loud on each, several at once. One copy per edge, inside each platform's sound
// class (windows/sound.js, linux/sound.js, mac/audio.js); one-to-one is the same with one edge.
//
// The receiver owns the route: settings.audio.routes[sender id] = [{id, vol}] (its speakers, by the
// sound window's device ids). Either side edits it: the receiver on its own page, the sender from its
// mixer with `audio.route {outs}`. The receiver keeps it, plays it and tells the sender what it has:
// `audio.outs {outs: [{id, name}], route, lat}` (its speakers, the route, the delay heard, ms). No
// route: the default speakers at the Volume, as before. An older app ignores both messages.
//
// Keep speakers in sync: the sender says `audio.route {sync: ms}` to every receiver; each holds its
// playback to that total delay (sound-outs.js), so speakers of several computers in one room play
// together instead of echoing. Off: as little delay as each can.
'use strict';

const P = require('./protocol.js');

const T = P.T;
const MAX_OUTS = 8;
const MAX_LIST = 16;
const MAX_ROUTES = 32;
const SYNC_MS = 200;

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const vol = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) / 100;

// [{id, vol}] or null (not a route).
function normOuts(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  const out = [];
  for (const o of v) {
    if (!o || typeof o !== 'object') continue;
    const id = str(o.id, 200);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, vol: vol(o.vol) });
    if (out.length >= MAX_OUTS) break;
  }
  return out;
}

// The speakers a sound window lists: [{id, name}].
function normList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((o) => o && typeof o.id === 'string').slice(0, MAX_LIST).map((o) => ({ id: str(o.id, 200), name: str(o.name, 120) || 'Speaker', ...(o.def ? { def: true } : {}) }));
}

// settings.audio.routes: {sender id: [{id, vol}]}
function normRoutes(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, outs] of Object.entries(v).slice(0, MAX_ROUTES)) {
    const n = normOuts(outs);
    if (k && k.length <= 200 && n) out[k] = n;
  }
  return out;
}

function normSync(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : 0;
}

class Routes {
  // send(m): to the peer; toWin(m): to the sound window; peerId(): the peer's device id ('' unknown);
  // cfg(): settings.audio; save(); onChange(); receiving(): its sound plays here now.
  constructor({ send, toWin, peerId, cfg, save = () => {}, onChange = () => {}, receiving = () => false }) {
    Object.assign(this, { send, toWin, peerId, cfg, save, onChange, receiving });
    this.remote = null; // what the receiver told us: {outs, route, lat}
    this.local = { outs: [], lat: 0 }; // what our window plays the peer's sound on
    this.sync = 0; // the sender's Keep speakers in sync (ms), for its sound here
    this.told = '';
  }

  // The route of the peer's sound here, or null (the default speakers at the Volume).
  route() {
    const id = this.peerId();
    const r = id && this.cfg().routes && this.cfg().routes[id];
    return Array.isArray(r) ? r : null;
  }

  // What plays: the route, else the default speaker at the Volume (so the sender's mixer shows it).
  playing() {
    const r = this.route();
    if (r) return r;
    const def = this.local.outs.find((o) => o.def) || this.local.outs[0];
    return def ? [{ id: def.id, vol: Math.round((Number(this.cfg().volume) || 0) * 100) / 100 }] : [];
  }

  // The window: where and when to play the peer's sound.
  push() {
    this.toWin({ t: 'route', outs: this.route(), sync: this.sync, volume: this.cfg().volume });
  }

  // audio.route from the sender: its pick of our speakers, and/or its sync.
  onRoute(m) {
    if (!m || typeof m !== 'object') return;
    if ('sync' in m) this.sync = normSync(m.sync);
    const outs = 'outs' in m ? normOuts(m.outs) : null;
    if (outs && this.setLocal(outs)) return; // kept, played and said
    this.push();
    this.tell(true);
  }

  // Our own page's pick (To this computer), or the sender's: kept, played, said.
  setLocal(outs) {
    const id = this.peerId();
    const n = normOuts(outs);
    if (!id || !n) return false;
    const c = this.cfg();
    c.routes = { ...normRoutes(c.routes), [id]: n };
    this.save();
    this.push();
    this.tell(true);
    this.onChange();
    return true;
  }

  // audio.outs from the receiver.
  onOuts(m) {
    if (!m || typeof m !== 'object') return;
    this.remote = { outs: normList(m.outs), route: normOuts(m.route), lat: Math.max(0, Math.min(5000, Math.round(Number(m.lat) || 0))) };
    this.onChange();
  }

  // The window's speakers and delay heard (it lists them when it plays).
  onWin(info) {
    if (!info || typeof info !== 'object') return;
    const next = { outs: normList(info.outs), lat: Math.max(0, Math.round(Number(info.lat) || 0)) };
    const was = this.local;
    this.local = next;
    const listChanged = JSON.stringify(was.outs) !== JSON.stringify(next.outs);
    if (listChanged || Math.abs(was.lat - next.lat) >= 3) {
      this.tell(listChanged);
      this.onChange();
    }
  }

  // To the sender: our speakers, its route and the delay. Only while its sound plays here.
  tell(force) {
    if (!this.receiving()) return;
    const m = { t: T.AUDIO_OUTS, outs: this.local.outs, route: this.playing(), lat: this.local.lat };
    const key = JSON.stringify(m);
    if (!force && key === this.told) return;
    this.told = key;
    this.send(m);
  }

  // From the sender's mixer: the receiver's speakers for our sound.
  setRemote(outs) {
    const n = normOuts(outs);
    if (!n) return false;
    if (this.remote) this.remote = { ...this.remote, route: n }; // shown at once; the receiver confirms
    this.send({ t: T.AUDIO_ROUTE, outs: n });
    this.onChange();
    return true;
  }

  // Ours to send: Keep speakers in sync, said to the receiver while we send.
  sayingSync(on) {
    this.send({ t: T.AUDIO_ROUTE, sync: on ? SYNC_MS : 0 });
  }

  // The link went: what the peer said is gone.
  reset() {
    this.remote = null;
    this.sync = 0;
    this.local = { outs: [], lat: 0 };
    this.told = '';
  }

  view() {
    return { remote: this.remote, local: { outs: this.local.outs, lat: this.local.lat, route: this.playing() } };
  }
}

module.exports = { Routes, normOuts, normList, normRoutes, normSync, SYNC_MS, MAX_OUTS };
