// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume in Multi-device (mac|windows|linux/mesh): ReZume is between two devices, so here it works
// only while exactly one device is connected and it is a phone. With a computer connected (or
// more than one device), the ReZume page says to turn Multi-device off for it.
//
//   const solo = soloLink({ bus, sessions })   bus: hub.bus, sessions: hub.sessions
//   solo.link        what shared/rezume.js takes: on, send, peer, welcome, closed
//   solo.id()        the phone's device id while it is the only device, else null
//   solo.blocked()   why not: '' (it works, or nothing is connected), 'computer' or 'many'
//
// phoneAdb(bridge): the phone through wireless debugging for ReZume (its app in front, a page
// opened there), or null.
'use strict';

const P = require('./protocol.js');

function soloLink({ bus, sessions }) {
  const connected = () => bus.connectedIds();
  const osOf = (id) => { const s = sessions.get(id); return s ? s.peerOs : ''; };
  const id = () => {
    const c = connected();
    return c.length === 1 && P.isPhoneOs(osOf(c[0])) ? c[0] : null;
  };
  const blocked = () => {
    const c = connected();
    if (!c.length || id()) return '';
    return c.length === 1 ? 'computer' : 'many';
  };
  // welcome / closed as the only phone comes and goes (a second device ends it, its leaving starts it again).
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
  bus.onPeer('welcome', recheck);
  bus.onPeer('closed', recheck);
  const name = () => { const s = was && sessions.get(was); return (s && (s.displayName ? s.displayName() : s.name)) || 'the phone'; };
  return {
    id,
    blocked,
    recheck,
    link: {
      on: (t, fn) => bus.on(t, (m, from) => { if (from && from === id()) fn(m); }),
      send: (m) => { const to = id(); if (to) bus.send(to, m); },
      peer: () => (id() ? { os: osOf(id()), name: name() } : null),
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
