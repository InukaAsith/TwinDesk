// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume (shared/rezume.js): the file a window shows when the system's recent list alone doesn't
// say it. Used by each platform's activity.js.
//   A browser showing a local file (a PDF in Edge, Chrome, Firefox, Safari): its address is
//   file:///…, which is that file, a document, never a link (fileUrlPath).
//   Media players: VLC keeps its own recent list (vlc-qt-interface.ini, RecentsMRL), PotPlayer its
//   own (Activity.cs); a player or Photos that went on to the next file of a folder shows a name
//   the recent list doesn't have, found next to the files that list does have (inFolders).
//   Titles carry invisible marks (Windows' Store apps put U+200E around the name): clean().
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { titleShows } = require('./browsertabs.js');

// Direction marks, zero-width spaces and joiners, BOM.
const clean = (t) => String(t || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

// file:///C:/a%20b.pdf → C:\a b.pdf (Windows), file:///home/me/a.pdf → /home/me/a.pdf. Edge's
// address bar may also show the path itself ("C:/Users/me/a.pdf"). '' for anything else.
function fileUrlPath(u, plat = process.platform) {
  const s = String(u || '').trim();
  if (plat === 'win32' && /^[A-Za-z]:[\\/]/.test(s)) return s.replace(/\//g, '\\');
  if (!/^file:/i.test(s)) return '';
  let x;
  try { x = new URL(s); } catch (_) { return ''; }
  let p;
  try { p = decodeURIComponent(x.pathname); } catch (_) { return ''; }
  if (plat === 'win32') {
    if (x.hostname) return '\\\\' + x.hostname + p.replace(/\//g, '\\');
    if (!/^\/[A-Za-z]:\//.test(p)) return '';
    return p.slice(1).replace(/\//g, '\\');
  }
  if (x.hostname && x.hostname !== 'localhost') return '';
  return p.startsWith('/') ? p : '';
}

// The file names a title shows: "IMG_0042.jpg - Photos", "*notes.txt - Mousepad", "PotPlayer - movie.mkv".
function titleNames(title) {
  const out = [];
  for (let part of clean(title).split(/\s+[-—–|•·]\s+/)) {
    part = part.replace(/^[*•]\s*/, '').replace(/\s*\[[^\]]*\]$/, '').trim();
    if (/^[^\\/:*?"<>|]{1,240}\.[A-Za-z0-9]{2,5}$/.test(part) && !/^[\w-]+\.(com|org|net|io|dev|app)$/i.test(part)) out.push(part);
  }
  return out;
}

// Pictures, video, audio and PDFs: what a viewer or player shows by its file's name.
const MEDIA = /\.(pdf|jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|raw|cr2|cr3|nef|arw|dng|svg|mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpe?g|ts|m2ts|3gp|ogv|mp3|m4a|aac|flac|wav|ogg|opus|wma|alac)$/i;

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

// The first of these files whose name (or name without its extension) the title shows, still there.
function nameMatch(title, files) {
  const t = clean(title);
  for (const f of files || []) {
    const name = path.basename(f);
    const stem = name.replace(/\.[^.]+$/, '');
    if (stem === name) continue;
    if ((titleShows(t, name) || (stem.length >= 3 && titleShows(t, stem))) && exists(f)) return f;
  }
  return null;
}

// A file the title names in one of these folders: Photos' next picture, a player's next file.
// Only by its full name, extension and all (a bare word could be anything).
const listing = new Map(); // folder → {at, names}
function namesIn(dir) {
  let st;
  try { st = fs.statSync(dir); } catch (_) { return []; }
  const c = listing.get(dir);
  if (c && c.at === st.mtimeMs) return c.names;
  let names = [];
  try { names = fs.readdirSync(dir).slice(0, 5000); } catch (_) { names = []; }
  if (listing.size > 64) listing.clear();
  listing.set(dir, { at: st.mtimeMs, names });
  return names;
}

function inFolders(title, dirs) {
  const want = titleNames(title).map((n) => n.toLowerCase());
  if (!want.length) return null;
  const seen = new Set();
  for (const d of dirs || []) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    if (seen.size > 24) break;
    const hit = namesIn(d).find((n) => want.includes(n.toLowerCase()));
    if (hit && exists(path.join(d, hit))) return path.join(d, hit);
  }
  return null;
}

// VLC's own recent list, newest first (Windows and Linux; the Mac app keeps none there).
const VLC_INI = {
  win32: () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'vlc', 'vlc-qt-interface.ini'),
  linux: () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'vlc', 'vlc-qt-interface.ini'),
};
let vlcCache = { file: '', at: 0, list: [] };
function parseVlcIni(text, plat = process.platform) {
  const sec = /^\[RecentsMRL\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(String(text || ''));
  const line = sec && /^list=(.*)$/m.exec(sec[1]);
  if (!line) return [];
  const out = [];
  for (const m of line[1].matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|([^,]+))/g)) {
    const v = (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]).trim();
    const p = fileUrlPath(v, plat) || (plat === 'win32' ? '' : (v.startsWith('/') ? v : ''));
    if (p) out.push(p);
  }
  return out;
}
function vlcRecents(plat = process.platform) {
  const f = VLC_INI[plat] ? VLC_INI[plat]() : '';
  if (!f) return [];
  let st;
  try { st = fs.statSync(f); } catch (_) { return []; }
  if (vlcCache.file === f && vlcCache.at === st.mtimeMs) return vlcCache.list;
  let list = [];
  try { list = parseVlcIni(fs.readFileSync(f, 'utf8'), plat); } catch (_) { list = []; }
  vlcCache = { file: f, at: st.mtimeMs, list };
  return list;
}

const isVlc = (app) => /(^|[\\/])vlc(\.exe)?$|^vlc$|videolan/i.test(String(app || ''));

// What a player in front plays, by its own list: the file the title names, else the next one in a
// folder of the list, else (VLC shows a video's own title, not its file's) the newest it opened.
function playerFile(app, title, plat = process.platform) {
  if (!isVlc(app) || /^(vlc media player|vlc)$/i.test(clean(title))) return null; // nothing playing
  const list = vlcRecents(plat);
  if (!list.length) return null;
  return nameMatch(title, list) || inFolders(title, list.map((p) => path.dirname(p))) || (exists(list[0]) ? list[0] : null);
}

module.exports = { MEDIA, clean, fileUrlPath, titleNames, nameMatch, inFolders, parseVlcIni, vlcRecents, playerFile, isVlc };
