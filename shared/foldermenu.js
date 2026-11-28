// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Share folder, from the file manager's right-click menu: Explorer (windows/explorer.js, and on Windows 11
// its first-level menu, windows-helper/shellmenu), Finder's Quick Actions (mac/finder.js), and Nautilus,
// Caja, Nemo, Dolphin and Thunar (linux/sendto.js). TwinDesk comes up on "Share <folder> with…"
// (shared/folders-host.js): which devices get it, computers through TwinDesk Shared folders, phones
// through their Files app (shared/foldershare.js).
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

module.exports = { ARG, fromArgv, fromUrl };
