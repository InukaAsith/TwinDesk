// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps › Move windows on the Mac (#18), appsend.js's side of shared/movewin.js: a window
// grabbed with the move key (the helper's Grab.swift) crossed to the other computer with the pointer.
// It is streamed there as one of this Mac's app windows (papp.windows, `moved: true`) and kept out of
// the way here (the virtual display, else past the screens' right edge), so it is in one place at a
// time; it comes back when its copy there is closed or dragged back, from the menu bar, at a
// disconnect or at quit. Loaded only once a window is moved: with the switch off none of this is in memory.
// as: the AppSend (helper, server, moved Map, _poll, _park bounds, getSettings).
'use strict';

const { screen } = require('electron');

const MAX_POPUPS = 6;

// False: it stays (off, the other side doesn't take windows, Bluetooth, already there, gone).
async function moveOut(as, wid, pid) {
  if (!wid || !pid || !as.getSettings().apps.moveWindows || !as.accepts || !as.server.current) return false;
  if (as.moved.has(wid) || as._mine(wid) || as.server.current.transport === 'ble') return false;
  const r = await as.helper.request('appWindows', { pids: [pid] }).catch(() => null);
  const w = r && Array.isArray(r.windows) && r.windows.find((x) => x.wid === wid && !x.popup);
  if (!w) return false;
  as.moved.set(wid, { pid, x: w.x, y: w.y, w: w.w, h: w.h });
  as._poll();
  as.emit('change');
  // Out of the way once the grab let go: on the virtual display (clicks from there reach it; it is
  // made now if it wasn't there, so wait for it a moment), else past the right edge, where the
  // pointer can't reach it.
  const made = Promise.resolve(as._holdDisplay && as._holdDisplay()).catch(() => {});
  await Promise.all([new Promise((r) => setTimeout(r, 60)), Promise.race([made, new Promise((r) => setTimeout(r, 4000))])]);
  if (!as.moved.has(wid)) return true;
  const vb = (as.displays && as.displays.virtualBounds()) || as._edge();
  as.helper.request('appPlace', { wid, x: vb.x + 40, y: vb.y + 60 }).catch(() => {});
  return true;
}

// Moved windows (one, or all of them) back where they were, in front. home: dragged back past the
// edge, so it shows where the pointer comes in, its title bar under it.
function bringBack(as, wid, home = false) {
  let any = false;
  for (const [id, m] of [...as.moved]) {
    if (wid !== undefined && id !== wid) continue;
    as.moved.delete(id);
    any = true;
    let at = { x: m.x, y: m.y };
    if (home) {
      const p = screen.getCursorScreenPoint();
      at = { x: Math.round(p.x - m.w / 2), y: Math.max(0, Math.round(p.y - 12)) };
    }
    as.helper.request('appPlace', { wid: id, x: at.x, y: at.y }).catch(() => {});
  }
  if (!any) return;
  as._poll();
  as.emit('change');
}

// The moved windows in the helper's list: that one window with its process's pop-ups over it.
function list(as, all, out, pops) {
  for (const [wid, m] of as.moved) {
    const w = all.find((x) => x.wid === wid && !x.popup);
    if (!w) { as.moved.delete(wid); continue; } // closed here
    const e = as._entry(w, 'moved');
    out.push({ ...e, moved: true });
    const popups = all.filter((p) => p.popup && p.pid === m.pid && p.x >= w.x && p.y >= w.y && p.x < w.x + w.w && p.y < w.y + w.h)
      .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, MAX_POPUPS);
    for (const p of popups) {
      const pe = as._entry(p, 'moved');
      pops.push({ ...pe, popup: true, owner: wid, x: Math.round((p.x - w.x) * pe.scale), y: Math.round((p.y - w.y) * pe.scale) });
    }
  }
}

module.exports = { moveOut, bringBack, list };
