// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drop on a computer (shared/drop.js): the room joined to this app's links, and the page's actions.
// The same on all six apps: Multi-device (the mesh hub: every connected computer and phone is a direct
// link) and one-to-one (the one session, a computer or a phone).
//
//   const drop = dropHost({ selfId, name(), os, dir, settings(), save(), push(),
//     hub | link,                    hub: */mesh/hub.js; link: {on('welcome' | 'closed' | type, fn), send(m), current}
//     notify(title, body),           a new message while the window isn't in front (optional)
//     pick() → Promise<[paths]>,     Attach…: the system's file picker
//     open(path), reveal(path), downloads() → folder })
//   state.drop = drop.state()        small, with every push; the page asks for the view when rev changes
//   ipc 'drop' (a) → drop.act(a)     {do: view | send | files | del | clear | read | open | reveal | save | thumb | set}
//   In an Electron app: start({selfId, name, os, settings, save, push, hub | link}, () => window) does all three.
'use strict';

const fs = require('fs');
const path = require('path');
const { DropRoom, T } = require('./drop.js');

const TYPES = [T.HI, T.MSGS, T.MSG, T.DEL, T.WHO];

function dropHost(o) {
  const P = require('./protocol.js');
  let neighbors;
  let send;
  let isLeaf;
  let members;
  const wire = [];
  if (o.hub) {
    const hub = o.hub;
    const sess = (id) => (hub.sessions && hub.sessions.get(id)) || null;
    neighbors = () => (hub.bus.connectedIds ? hub.bus.connectedIds() : []);
    send = (id, m) => hub.bus.send(id, m);
    isLeaf = (id) => { const s = sess(id); return !!s && P.isPhoneOs(s.peerOs); };
    members = () => (hub.peers({ indirect: true }) || []).map((d) => ({ id: d.id, name: d.name, os: d.os, online: !!d.connected || d.state === 'via' }));
    wire.push((room) => {
      for (const t of TYPES) hub.bus.on(t, (m, from) => room.heard(t, m, from));
      hub.bus.onPeer('welcome', (id) => room.up(id));
    });
  } else {
    const link = o.link;
    const cur = () => { const c = link.current; return c && c.deviceId ? c : null; };
    neighbors = () => (cur() ? [cur().deviceId] : []);
    send = (id, m) => { const c = cur(); if (!c || c.deviceId !== id) return false; link.send(m); return true; };
    isLeaf = (id) => { const c = cur(); return !!c && c.deviceId === id && P.isPhoneOs(c.os); };
    members = () => { const c = cur(); return c ? [{ id: c.deviceId, name: c.name, os: c.os, online: true }] : []; };
    wire.push((room) => {
      for (const t of TYPES) link.on(t, (m) => { const c = cur(); if (c) room.heard(t, m, c.deviceId); });
      link.on('welcome', () => { const c = cur(); if (c) room.up(c.deviceId); });
    });
  }

  const room = new DropRoom({
    selfId: o.selfId, name: o.name, os: o.os, dir: o.dir, settings: o.settings, save: o.save,
    neighbors, send, isLeaf, members,
    onChange: () => o.push(),
    onNew: (it) => {
      if (!o.notify) return;
      const body = it.text || (it.file ? it.file.name : '');
      try { o.notify(it.name || 'Drop', body.slice(0, 200)); } catch (_) { /* no pop-up */ }
    },
  });
  for (const w of wire) w(room);

  const unique = (dir, name) => {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let p = path.join(dir, name);
    for (let i = 2; fs.existsSync(p) && i < 1000; i += 1) p = path.join(dir, `${base} (${i})${ext}`);
    return p;
  };

  async function act(a) {
    if (!a || typeof a !== 'object') return null;
    const id = typeof a.id === 'string' ? a.id : '';
    switch (a.do) {
      case 'view': return room.view();
      case 'send': return room.post({ to: a.to, text: a.text });
      case 'files': {
        let paths = Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === 'string') : null;
        if (!paths) paths = o.pick ? await o.pick() : [];
        const out = { ok: true, sent: 0, big: [], bad: [] };
        for (const p of (paths || []).slice(0, 20)) {
          const r = room.post({ to: a.to, file: { path: p } });
          if (r.ok) out.sent += 1;
          else if (r.why === 'big') out.big.push(path.basename(p));
          else if (r.why === 'off') return r;
          else out.bad.push(path.basename(p));
        }
        out.ok = !out.big.length && !out.bad.length;
        return out;
      }
      case 'del': return { ok: room.del(id, a.all === true) };
      case 'clear': room.clear(); return { ok: true };
      case 'read': room.read(); return { ok: true };
      case 'open': case 'reveal': {
        const p = room.filePath(id);
        if (!p) return { ok: false };
        if (a.do === 'open' && o.open) o.open(p);
        if (a.do === 'reveal' && o.reveal) o.reveal(p);
        return { ok: true };
      }
      case 'save': {
        const p = room.filePath(id);
        if (!p) return { ok: false };
        const dir = (o.downloads && o.downloads()) || path.join(require('os').homedir(), 'Downloads');
        try {
          fs.mkdirSync(dir, { recursive: true });
          const to = unique(dir, path.basename(p));
          fs.copyFileSync(p, to);
          if (o.reveal) o.reveal(to);
          return { ok: true, path: to };
        } catch (e) { return { ok: false, why: e.message }; }
      }
      case 'thumb': {
        const v = room.byId && room.byId.get(id);
        const p = room.filePath(id);
        if (!p || !v || !v.file || !/^image\//.test(v.file.mime || '')) return '';
        try { return `data:${v.file.mime};base64,${fs.readFileSync(p).toString('base64')}`; } catch (_) { return ''; }
      }
      case 'set':
        if (typeof a.on === 'boolean') room.setOn(a.on);
        if (a.block && typeof a.block.id === 'string') room.block(a.block.id, a.block.on !== false, a.block.name);
        return { ok: true };
      default: return null;
    }
  }

  return { room, act, state: () => room.state(), flush: () => room.flush() };
}

// The Electron parts every app passes the same way: its folder, the file picker, Open / Show in folder,
// Downloads, and a pop-up for a new message while the window isn't in front.
function electronParts(getWin) {
  const { app, dialog, shell, Notification } = require('electron');
  return {
    dir: app.getPath('userData'),
    downloads: () => app.getPath('downloads'),
    pick: async () => { const r = await dialog.showOpenDialog(getWin() || undefined, { properties: ['openFile', 'multiSelections'] }); return r.canceled ? [] : r.filePaths; },
    open: (p) => shell.openPath(p),
    reveal: (p) => shell.showItemInFolder(p),
    notify: (title, body) => {
      const w = getWin();
      if (w && !w.isDestroyed() && w.isVisible() && w.isFocused()) return;
      try { new Notification({ title, body }).show(); } catch (_) { /* none */ }
    },
  };
}

// Everything at once: the host, the page's 'drop' call, and its state. Returns the host.
function start(o, getWin) {
  const host = dropHost({ ...electronParts(getWin), ...o });
  require('electron').ipcMain.handle('drop', (_e, a) => host.act(a));
  require('electron').app.on('before-quit', () => host.flush());
  return host;
}

module.exports = { dropHost, electronParts, start };
