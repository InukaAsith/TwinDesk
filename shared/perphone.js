// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device (mac|windows|linux/mesh): a phone feature written for one phone's link ('client',
// 'closed', 't:<type>', sendToClient, current) once per phone of the PhoneSet (mesh/phones.js).
// Each is made with that phone's stack (PhoneSet's onUnit), so it hears the phone's first messages,
// or, for one behind a switch, when the switch is turned on; the pages see the active phone's.
//
//   const set = new PerPhone((link, unit) => instance, { want: () => bool })
//   set.unit(u)      from onUnit: made now, while wanted
//   set.load(units)  the switch turned on: made for every phone there is
//   set.of(u)        that phone's, or null;  set.each(fn)
//
//   phoneMedia({ NowPlaying, cfg, onChange, phones: () => PhoneSet }) → the ipc's `nowPlaying`
//     (apply(), control(a, pos), view) over one shared/nowplaying.js per phone, plus unit(u).
//   anyPhone({ want(ctx) }) → { unit(u), link }: a one-to-one link (on 'welcome'|'closed'|type, send,
//     current) with ONE phone at a time, as the one-to-one app has one peer (TwinDesk iPhone's
//     signing: a second iPhone never cuts into the first one's run). The first wanted phone that
//     connects is held until it leaves; the others aren't heard meanwhile; then the next one there.
//   phoneRemote({ PhoneRemote, opts, wanted, phones }) → the Remote page's (setAllow, setPad,
//     refresh, view) over one shared/phone-remote.js per phone; each phone's Remote page drives this
//     computer; the page shows the active phone's. opts: PhoneRemote's options but server.
'use strict';
const P = require('./protocol.js');

class PerPhone {
  constructor(make, { want = () => true } = {}) {
    this.make = make;
    this.want = want;
    this.made = new Map(); // unit → instance
  }

  unit(u) {
    if (!u) return null;
    if (this.made.has(u)) return this.made.get(u);
    if (!this.want()) return null;
    const x = this.make(u.link, u);
    this.made.set(u, x);
    return x;
  }

  load(units) {
    for (const u of units || []) this.unit(u);
  }

  of(u) {
    return (u && this.made.get(u)) || null;
  }

  each(fn) {
    for (const x of this.made.values()) fn(x);
  }
}

// What plays on each phone (Audio › Media controls): one NowPlaying per phone while the switch is
// on; the Overview's controls and view are the active phone's.
function phoneMedia({ NowPlaying, cfg, onChange, phones }) {
  const set = new PerPhone((link) => {
    const n = new NowPlaying({ server: link, cfg });
    n.on('change', onChange);
    n.apply(); // a phone already there is asked now
    return n;
  }, { want: () => cfg().phoneMedia !== false });
  const active = () => { const p = phones(); return p ? set.of(p.active) : null; };
  return {
    unit: (u) => set.unit(u),
    // The switch: on, made for every phone and asked; off, each one stops.
    apply() {
      const p = phones();
      if (p) set.load(p.all);
      set.each((n) => n.apply());
    },
    control(a, pos) {
      const n = active();
      if (n) n.control(a, pos);
    },
    get view() {
      const n = active();
      return n ? n.view : null;
    },
  };
}

// Remote (shared/phone-remote.js) for every phone: made once Remote (or Keyboard's voice typing) is
// on; until then a phone opening its Remote page hears it's off (onPhone, from each unit's link).
const REMOTE_OFF_WHY = 'Remote is off on this computer: turn it on in TwinDesk’s Remote page there';
function phoneRemote({ PhoneRemote, opts, wanted, phones }) {
  const set = new PerPhone((link) => {
    const r = new PhoneRemote({ ...opts, server: link });
    r.refresh(); // its page may be open already
    return r;
  }, { want: wanted });
  const active = () => { const p = phones(); return p ? set.of(p.active) : null; };
  return {
    unit(u) {
      // Off here (not made): the phone's Remote page hears so.
      u.link.on(`t:${P.T.REMOTE_HELLO}`, () => !set.of(u) && u.link.current && u.link.sendToClient({ t: P.T.REMOTE_STATE, allowed: false, off: true, why: REMOTE_OFF_WHY, voice: false, voiceWhy: P.KEYBOARD_OFF }));
      return set.unit(u);
    },
    // Turned on: made for every phone there is.
    load() {
      const p = phones();
      if (p) set.load(p.all);
      return set.made.size > 0;
    },
    get loaded() { return set.made.size > 0; },
    setAllow(on) { set.each((r) => r.setAllow(on)); },
    setPad(on) { const r = active(); if (r) r.setPad(on); },
    refresh() { set.each((r) => r.refresh()); },
    get view() { const r = active() || set.made.values().next().value; return r ? r.view : null; },
  };
}

// A feature written for one phone's link that serves whichever phone comes: what it hears comes from
// every phone; what it sends goes to the one that connected or spoke last; 'closed' is that one's.
function anyPhone({ want = () => true } = {}) {
  const handlers = [];
  const units = [];
  let held = null; // the one phone this link is with, as the one-to-one link has one peer
  const up = (u) => !!(u.link.current && want(u.link.current));
  const emit = (ev, ...a) => { for (const [e, fn] of handlers) if (e === ev) fn(...a); };
  // Nobody held: the first phone connected (and wanted) is, and its welcome goes out.
  const pick = (skip = null) => {
    if (held) return;
    held = units.find((u) => u !== skip && up(u)) || null;
    if (held) emit('welcome', held.link.current);
  };
  const watch = (u) => {
    u.link.on('client', () => pick());
    u.link.on('closed', (...a) => {
      if (held !== u) return;
      held = null;
      emit('closed', ...a);
      pick(u); // another phone that's still here takes over, from the start
    });
  };
  return {
    unit(u) {
      units.push(u);
      watch(u);
      for (const [ev, fn] of handlers) if (ev !== 'welcome' && ev !== 'closed') u.link.on(`t:${ev}`, (m, ctx) => { if (held === u) fn(m, ctx); });
      pick();
    },
    link: {
      on(ev, fn) {
        handlers.push([ev, fn]);
        if (ev === 'welcome' || ev === 'closed') return;
        for (const u of units) u.link.on(`t:${ev}`, (m, ctx) => { if (held === u) fn(m, ctx); });
      },
      send(m) { if (held && held.link.current) held.link.sendToClient(m); },
      get current() { return held ? held.link.current : null; },
    },
  };
}

module.exports = { PerPhone, phoneMedia, phoneRemote, anyPhone };
