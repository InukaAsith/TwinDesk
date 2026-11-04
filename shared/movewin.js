// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps › Move windows (#18): a window grabbed with the move key (the helper) crossed to
// the other computer with the pointer. It is streamed there as one of the PC apps' windows (papp.*,
// `moved: true`) and parked out of sight here, so it is in one place at a time; it comes back when
// its copy there is closed or dragged back, from the tray, at a disconnect or at quit.
// Loaded only once a window is moved (pcapps.js): with the switch off none of this is in memory.
// pc: the platform's PcApps (helper, link, moved Map, _poll, onChange, _cursorPx(), _movedExtra(w):
// what else its list entries carry, e.g. the work area's size).
'use strict';

const MAX_POPUPS = 6;
const IDLE_MS = 2500; // a moved window used from its copy is parked again this long after the last input

// False: it stays (off, the other side doesn't take windows, Bluetooth, already there, gone).
// from: {x, y}, its visible frame's top left when it was grabbed (the helper's fromX/fromY): it comes
// back there, not to the edge it was dragged to (where it would sit half on the screen).
async function moveOut(pc, wid, from) {
  if (typeof wid !== 'number' || !wid || !pc.settings.pcApps.moveWindows || !pc.macAccepts) return false;
  if (pc.moved.has(wid) || pc._mine(wid) || (pc.link.current && pc.link.current.transport === 'ble')) return false;
  const r = await pc.helper.request('windows').catch(() => null);
  const w = r && Array.isArray(r.windows) && r.windows.find((x) => x.wid === wid && !x.popup);
  if (!w) return false;
  const at = from && Number.isFinite(from.x) && Number.isFinite(from.y) ? from : w;
  pc.moved.set(wid, { x: Math.round(at.x), y: Math.round(at.y), w: w.w, h: w.h, pid: w.pid });
  setTimeout(() => pc.moved.has(wid) && pc.helper.send('winPark', { wid }), 60); // once the grab let go
  pc._poll(true);
  pc.onChange();
  return true;
}

// Moved windows (one, or all of them) back where they were, in front. home: dragged back past the
// edge, so it shows where the pointer comes in, its title bar under it.
function bringBack(pc, wid, home = false) {
  let any = false;
  for (const [id, m] of [...pc.moved]) {
    if (wid !== undefined && id !== wid) continue;
    pc.moved.delete(id);
    clearTimeout(m.timer);
    any = true;
    let at = m;
    if (home) {
      const p = pc._cursorPx();
      at = { x: Math.round(p.x - m.w / 2), y: Math.max(0, Math.round(p.y - 12)) };
    }
    pc.helper.send('winPlace', { wid: id, x: at.x, y: at.y });
  }
  if (!any) return;
  if (!pc.stopped) pc._poll(true);
  pc.onChange();
}

// Input from its copy there: parked past the screens, the pointer can't reach it (the helper puts
// the pointer on the window), so it comes back where it was, in front, while it's used, and is parked
// again once the input stops for IDLE_MS. The commands go in order: it's placed before the input lands.
function touch(pc, wid) {
  const m = pc.moved.get(wid);
  if (!m) return;
  if (!m.out) {
    m.out = true;
    pc.helper.send('winPlace', { wid, x: m.x, y: m.y });
  }
  clearTimeout(m.timer);
  m.timer = setTimeout(() => {
    if (pc.moved.get(wid) !== m || !m.out) return;
    m.out = false;
    pc.helper.send('winPark', { wid });
  }, IDLE_MS);
}

// The moved windows in the helper's list (all): that one window, not its app's others, with its
// process's pop-ups (menus). Taken wids go in `taken`; a moved window that closed is forgotten.
function list(pc, all, taken, out, pops) {
  for (const [wid, m] of pc.moved) {
    const w = all.find((x) => x.wid === wid);
    if (!w) { pc.moved.delete(wid); continue; }
    taken.add(wid);
    out.push({ wid, id: 'moved', moved: true, title: w.title, w: w.w, h: w.h, scale: w.scale, ...pc._movedExtra({ ...w, x: m.x, y: m.y }) });
    for (const p of all.filter((x) => x.popup && x.pid === m.pid && !taken.has(x.wid) && (x.w >= 64 || x.h >= 64)).slice(0, MAX_POPUPS)) {
      taken.add(p.wid);
      pops.push({ wid: p.wid, id: 'moved', title: p.title, w: p.w, h: p.h, scale: p.scale, popup: true, owner: wid, x: p.x - w.x, y: p.y - w.y });
    }
  }
}

module.exports = { moveOut, bringBack, touch, list };
