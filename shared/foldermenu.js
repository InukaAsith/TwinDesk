// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Share this folder, from the file manager's right-click menu: Explorer (windows/explorer.js, and on
// Windows 11 its first-level menu, windows-helper/shellmenu), Finder's Quick Actions (mac/finder.js),
// and Nautilus, Caja, Nemo, Dolphin and Thunar (linux/sendto.js). The folder becomes the one this
// computer shares with the phone (shared/foldershare.js: the phone's Files app and every app's file
// picker see it), and sharing is switched on. Nothing else changes: the same switch on Phone Files
// turns it off again.
//   Windows, Linux: TwinDesk is started with `--td share <folder>` (a running one gets it as
//                   second-instance argv).
//   Mac:            macshare://share-folder?h=<the path's UTF-8 bytes in hex> (open-url), hex so a
//                   Quick Action's script needs no escaping.
'use strict';

const fs = require('fs');
const path = require('path');

const ARG = '--td';
const MAX_PATH = 1000; // as the settings keep it

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// argv with --td share <folder>: the folder ('' when the argument isn't a folder), or null when it isn't ours.
function fromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const i = list.indexOf(ARG);
  if (i < 0 || list[i + 1] !== 'share') return null;
  const dir = String(list[i + 2] || '').replace(/"$/, '');
  return path.isAbsolute(dir) && dir.length <= MAX_PATH && isDir(dir) ? path.resolve(dir) : '';
}

// macshare://share-folder?h=…: the folder ('' when it isn't one), or null when it isn't ours.
function fromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.host !== 'share-folder' && u.pathname.replace(/^\/+/, '') !== 'share-folder') return null;
  const h = u.searchParams.get('h') || '';
  if (!/^(?:[0-9a-fA-F]{2}){1,1000}$/.test(h)) return '';
  const dir = Buffer.from(h, 'hex').toString('utf8');
  return path.isAbsolute(dir) && dir.length <= MAX_PATH && isDir(dir) ? path.resolve(dir) : '';
}

// The folder shared with the phone: through the hub when it's loaded (it serves it now), else in the
// settings, which the hub reads when the phone connects (shareServe makes it load then).
// o: hub() → the PhoneHub or null; settings() → the app's settings; save(); popup(kind, text, sub);
//    goTab(tab); phoneOn() → a phone is connected.
async function share(dir, o) {
  if (!dir) return false;
  const name = path.basename(dir) || dir;
  const hub = o.hub && o.hub();
  if (hub && hub.share) await hub.share.act('folder', { path: dir });
  else {
    const s = o.settings();
    s.hub = { ...(s.hub || {}), shareFolder: dir, shareServe: true };
    o.save();
  }
  if (o.goTab) o.goTab('pfiles');
  if (o.popup) o.popup('home', { key: 'Sharing {name} with the phone', vars: { name } }, o.phoneOn && o.phoneOn() ? { key: 'It’s in the phone’s Files app' } : { key: 'The phone sees it when it connects' });
  return true;
}

module.exports = { ARG, fromArgv, fromUrl, share };
