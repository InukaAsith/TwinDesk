// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A phone's Send to another computer of the mesh (the phone share picker, phase 3 of the 2026-11-28 plan):
// a phone is connected to one computer; its share sheet may pick another one. Its file.offer then says
// `to` (that device's id), and the computer it's connected to takes the batch into a folder of its own
// (not Received files), sends it on to that device with its own Send files, and removes it an hour later.
// Only for phones, only to a connected device of the mesh, only Send files; anything else is received
// as before. Windows and Linux (filerecv.js relayDir), the Mac (mac/drop.js).
//
//   const relay = filesRelay({ selfId, isPhone(id), connected(id), sendTo(id, paths) → bool, nameOf(id), notify(text, vars) })
//   new FileRecv({ ..., relayDir: (to, batch) => relay.dir(scoped.id, to, batch) })
//   fileRecv.onBatch = (b) => { if (relay.done(b)) return; ... }
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.tmpdir(), 'TwinDesk relay');
const KEEP_MS = 60 * 60 * 1000;
const ID = /^[A-Za-z0-9._-]{1,64}$/;

function filesRelay({ selfId, isPhone, connected, sendTo, nameOf = (id) => id, notify = () => {} }) {
  const self = () => (typeof selfId === 'function' ? selfId() : selfId);
  // Left from an earlier run: gone.
  try { for (const d of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, d), { recursive: true, force: true }); } catch (_) { /* none */ }

  const api = {
    notify, // replaceable once the app's pop-ups exist (the Mac makes this before its Hud)
    // The folder a phone's batch for `to` goes into, or '' to receive it here as usual.
    dir(from, to, batch) {
      if (typeof to !== 'string' || !ID.test(to) || to === self() || to === from) return '';
      if (!isPhone(from) || !connected(to)) return '';
      const d = path.join(ROOT, String(batch || Date.now()).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || String(Date.now()));
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) { return ''; }
      return d;
    },
    // A batch finished: one for another device goes on to it. True when it was one.
    done(b) {
      if (!b || !b.to) return false;
      const ok = !!(b.placed && b.placed.length) && sendTo(b.to, b.placed);
      api.notify(ok ? 'Passing {count} file(s) to {name}' : 'Couldn’t pass files to {name}', { count: b.files || 0, name: nameOf(b.to) });
      const dir = b.placed && b.placed[0] ? path.dirname(b.placed[0]) : '';
      if (dir.startsWith(ROOT)) setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), KEEP_MS).unref();
      return true;
    },
  };
  return api;
}

module.exports = { filesRelay, ROOT };
