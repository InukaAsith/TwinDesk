// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared folders in a computer's app (phase 3 of the 2026-11-28 plan; the rules: shared/drive-folders.js):
// the File Sharing page's Shared folders card and the "Share <folder> with…" sheet that the file
// manager's Share folder opens (shared/foldermenu.js). Works with Drive's engine loaded or not:
//   - a folder shared with a computer needs the sync engine (drive-host.js), loaded for it; TwinDesk
//     Drive's own folder (a separate feature) stays as it is;
//   - one shared with phones only is served by the phone share (shared/foldershare.js), told at once.
// The same on Windows, Linux and the Mac, one to one and Multi-device.
//
//   const fh = foldersHost({ settings, save, push, getDrive, loadDrive, phoneShare, devices, pick, show })
//     devices() → [{id, name, os}]: the devices a folder can be shared with (paired, connected or not)
//     phoneShare() → the FolderShare while the phone hub is loaded, else null
//     pick() → Promise<folder path | ''>: the system's folder picker; show(): bring the window up
//   fh.view()              state.folders: {list, offers, devices, sheet}
//   fh.ask(dir)            the sheet for this folder (Share folder in the file manager)
//   fh.actions             {folderShare({path, devices}), folderSheet(null), folderAdd(), folderRemove(id),
//                           folderDevices({id, devices}), folderAccept(id), folderDecline(id), folderOpen(id)}
'use strict';

const path = require('path');
const P = require('./protocol.js');
const DF = require('./drive-folders.js');

function foldersHost({ settings, save, push, getDrive, loadDrive, phoneShare = () => null, devices = () => [], pick = async () => '', show = () => {}, open = () => {} }) {
  let sheet = null; // {path, name}: the sheet waiting for an answer
  const cfg = () => {
    const s = settings();
    if (!s.drive) s.drive = { on: false, folder: '' };
    if (!Array.isArray(s.drive.folders)) s.drive.folders = [];
    return s.drive;
  };
  const isPhone = (id) => { const d = devices().find((x) => x.id === id); return !!d && P.isPhoneOs(d.os); };
  const hasComputer = (list) => !Array.isArray(list) || list.some((id) => !isPhone(id)); // 'all': computers paired later too
  const tellPhone = () => { const f = phoneShare(); if (f) Promise.resolve(f.host()).catch(() => {}); };

  // A computer among a folder's devices: the engine is loaded (it runs for the shared folders by itself).
  async function engine(list) {
    if (!hasComputer(list)) return getDrive();
    return getDrive() || loadDrive();
  }

  async function add({ id, name, path: p, devices: list }) {
    const devs = DF.cleanDevices(list);
    const d = await engine(devs);
    let fid;
    if (d && d.addFolder) fid = await d.addFolder({ id, name, path: p, devices: devs });
    else {
      const c = cfg();
      if (c.folders.length >= DF.MAX) return null;
      fid = DF.ID.test(String(id)) ? id : require('crypto').randomBytes(8).toString('hex');
      if (!c.folders.some((x) => x.id === fid)) c.folders.push({ id: fid, name: DF.safeName(name), path: typeof p === 'string' ? p : '', devices: devs });
      save();
    }
    tellPhone();
    push();
    return fid;
  }

  const actions = {
    // The sheet's Share: this folder with these devices ('all' or ids). A folder already shared: its devices.
    async folderShare(o) {
      const dir = o && typeof o.path === 'string' && path.isAbsolute(o.path) ? o.path : '';
      sheet = null;
      if (!dir) return push();
      const was = cfg().folders.find((f) => DF.pathOf(f) === dir);
      if (was) return actions.folderDevices({ id: was.id, devices: o.devices });
      await add({ name: path.basename(dir) || dir, path: dir, devices: o.devices });
    },
    folderSheet() {
      sheet = null;
      push();
    },
    // Add folder… on the card: the picker, then the sheet for it.
    async folderAdd() {
      const dir = await pick();
      if (dir) actions.ask(dir);
    },
    async folderRemove(id) {
      const d = getDrive();
      if (d && d.removeFolder) await d.removeFolder(id);
      else { const c = cfg(); c.folders = c.folders.filter((f) => f.id !== id); save(); }
      tellPhone();
      push();
    },
    async folderDevices(o) {
      const id = o && typeof o.id === 'string' ? o.id : '';
      const devs = DF.cleanDevices(o && o.devices);
      const f = cfg().folders.find((x) => x.id === id);
      if (!f) return;
      const d = await engine(devs);
      if (d && d.setFolderDevices) d.setFolderDevices(id, devs);
      else { f.devices = devs; save(); }
      tellPhone();
      push();
    },
    // A folder another computer shares with this one: taken as it named it.
    async folderAccept(id) {
      const offer = ((getDrive() && getDrive().view().offers) || []).find((o) => o.f === id);
      if (offer) await add({ id, name: offer.name, devices: 'all' });
    },
    // An invitation not wanted: hidden from now on (settings.drive.declined; the other computer isn't told).
    folderDecline(id) {
      if (typeof id !== 'string' || !DF.ID.test(id)) return;
      const c = cfg();
      c.declined = [...new Set([...(Array.isArray(c.declined) ? c.declined : []), id])].slice(-64);
      save();
      push();
    },
    folderOpen(id) {
      const f = cfg().folders.find((x) => x.id === id);
      if (f) open(DF.pathOf(f));
    },
    ask(dir) {
      if (!dir) return;
      sheet = { path: dir, name: path.basename(dir) || dir };
      show();
      push();
    },
  };

  return {
    actions,
    ask: actions.ask,
    view() {
      const c = cfg();
      const dv = getDrive() ? getDrive().view() : null;
      const live = new Map(((dv && dv.folders) || []).map((f) => [f.id, f]));
      return {
        max: DF.MAX,
        list: DF.cleanFolders(c.folders).map((f) => ({ ...(live.get(f.id) || {}), id: f.id, name: f.name, path: DF.pathOf(f), devices: f.devices })),
        offers: ((dv && dv.offers) || []).filter((o) => !(Array.isArray(c.declined) && c.declined.includes(o.f))),
        devices: devices().slice(0, 32).map((d) => ({ id: d.id, name: d.name || d.id.slice(0, 8), os: d.os || '', ...(typeof d.connected === 'boolean' ? { connected: d.connected } : {}) })),
        sheet: sheet ? { ...sheet, shared: (c.folders.find((f) => DF.pathOf(f) === sheet.path) || {}).devices || null } : null,
      };
    },
  };
}

module.exports = { foldersHost };
