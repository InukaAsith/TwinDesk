// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume in Multi-device (mac|windows|linux/mesh): ReZume is between two devices, so here it works
// with ONE of them at a time, its partner.
//
//   const solo = soloLink({ bus, sessions, partner })   bus: hub.bus, sessions: hub.sessions
//   solo.link        what shared/rezume.js takes: on, send, peer, welcome, closed
//   solo.id()        the device ReZume is with now (connected), else null
//   solo.blocked()   why not: '' (it works, or nothing is connected), 'pick' (choose one on the ReZume
//                    page); without `partner`: 'computer' or 'many' (only a phone alone, as before)
//   solo.choose(id)  ReZume with this device ('' or null: with none)
//   solo.view()      { with: id | '', devices: [{ id, name, os }] } for the ReZume page's picker
//
// partner: { get() -> { id, at } | null, set(v) } (settings.rezume.with). The pick is mutual between
// computers: A picks C, so C is told (rz.partner {on: true, at}) and is with A; whoever either of them
// was with before is told it's over (rz.partner {on: false}). Picked while apart, the newer pick wins
// when they meet again (said again with again: true). A phone takes no part in that: picking it is this computer's alone. With no
// partner picked, a phone that is the only device connected is the one, as before.
//
// phoneAdb(bridge): the phone through wireless debugging for ReZume (its app in front, a page
// opened there), or null.
'use strict';

const P = require('./protocol.js');

function soloLink({ bus, sessions, partner = null }) {
  const T = P.T;
  const connected = () => bus.connectedIds();
  const isOn = (id) => !!id && connected().includes(id);
  const osOf = (id) => { const s = sessions.get(id); return s ? s.peerOs : ''; };
  const isPhone = (id) => P.isPhoneOs(osOf(id));
  const nameOf = (id) => { const s = id && sessions.get(id); return (s && (s.displayName ? s.displayName() : s.name)) || ''; };
  const picked = () => { const v = partner && partner.get(); return v && typeof v.id === 'string' && v.id ? v : null; };
  const lone = () => { const c = connected(); return c.length === 1 && isPhone(c[0]) ? c[0] : null; };
  const id = () => {
    const p = picked();
    if (p) return isOn(p.id) ? p.id : null;
    return lone();
  };
  const blocked = () => {
    const c = connected();
    if (!c.length || id()) return '';
    if (partner) return 'pick';
    return c.length === 1 ? 'computer' : 'many';
  };
  // welcome / closed as the device ReZume is with comes and goes, or another is picked.
  const welcomes = [];
  const closes = [];
  let was = null;
  const recheck = () => {
    const now = id();
    if (now === was) return;
    if (was) for (const fn of closes) fn();
    was = now;
    if (now) for (const fn of welcomes) fn();
  };
  // again: said once more as the two meet (not picked just now), so the newer pick wins on the other side.
  const tell = (to, on, at, again = false) => { if (isOn(to) && !isPhone(to)) bus.send(to, on ? { t: T.RZ_PARTNER, on: true, at, ...(again ? { again: true } : {}) } : { t: T.RZ_PARTNER, on: false }); };

  function choose(to) {
    if (!partner) return;
    to = typeof to === 'string' ? to : '';
    const cur = picked();
    if (cur && cur.id === to) return;
    if (cur) tell(cur.id, false);
    const at = Date.now();
    partner.set(to ? { id: to, at } : null);
    if (to) tell(to, true, at);
    recheck();
  }

  if (partner) {
    bus.on(T.RZ_PARTNER, (m, from) => {
      if (!from || isPhone(from)) return;
      const cur = picked();
      if (m && m.on === true) {
        const at = Number.isFinite(m.at) ? m.at : 0;
        if (m.again === true && cur && cur.id !== from && cur.at >= at) return tell(from, false); // met again, but picked something newer here (a tie keeps it)
        if (cur && cur.id !== from) tell(cur.id, false);
        if (!cur || cur.id !== from || cur.at !== at) partner.set({ id: from, at });
      } else if (cur && cur.id === from) partner.set(null);
      recheck();
    });
    // The two meet again: say it once more (the newer pick wins on the other side).
    bus.onPeer('welcome', (from) => { const cur = picked(); if (cur && cur.id === from) tell(from, true, cur.at, true); });
  }
  bus.onPeer('welcome', recheck);
  bus.onPeer('closed', recheck);

  const view = () => {
    const p = picked();
    return {
      with: p ? p.id : '',
      withName: p ? nameOf(p.id) : '',
      devices: connected().map((d) => ({ id: d, name: nameOf(d) || d, os: osOf(d) })),
    };
  };
  return {
    id,
    blocked,
    recheck,
    choose,
    view,
    link: {
      on: (t, fn) => bus.on(t, (m, from) => { if (from && from === id()) fn(m); }),
      send: (m) => { const to = id(); if (to) bus.send(to, m); },
      peer: () => { const d = id(); return d ? { os: osOf(d), name: nameOf(d) || (isPhone(d) ? 'the phone' : 'the other computer') } : null; },
      welcome: (fn) => welcomes.push(fn),
      closed: (fn) => closes.push(fn),
    },
  };
}

function phoneAdb(b) {
  if (!b || b.state !== 'ready' || !b.serial) return null;
  return {
    ready: true,
    front: async () => {
      const r = await b.adb.shell(b.serial, 'dumpsys activity activities | grep -m 1 -E "topResumedActivity|mResumedActivity"', { timeout: 4000 });
      const m = /\s([\w.]+)\/[\w.$]+/.exec(r.out || '');
      return m ? m[1] : '';
    },
    openUrl: (u) => b.adb.shell(b.serial, `am start -a android.intent.action.VIEW -d '${String(u).replace(/'/g, "'\\''")}'`, { timeout: 6000 }),
  };
}

module.exports = { soloLink, phoneAdb };
