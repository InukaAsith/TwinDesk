// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume here (shared/rezume.js): what is in use in the window in front. X11: the helper names
// it (activeWindow: class, title); Wayland has no such query, and the accessibility bus (AT-SPI, on
// by default on GNOME and KDE) says which window is active. A browser's address comes from its
// address bar through AT-SPI (Firefox; Chromium browsers when their accessibility is on), else from
// the browser's own files (shared/browsertabs.js); a document is the recently used file
// (recently-used.xbel, which GTK apps keep, and KDE's RecentDocuments) whose name the title shows,
// else VLC's own list, else a file of that name next to the recent ones (a viewer's next picture,
// a player's next file: shared/docfind.js). A browser showing a local file (a PDF) offers that file. One Python process
// (GObject introspection, as linux/fm.js) answers while ReZume looks, started the first time.
// Anything else is at least the app itself (kind 'app', its WM_CLASS), whose window ReZume may send
// to another computer (X11 only).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tabs = require('../shared/browsertabs.js');
const docfind = require('../shared/docfind.js');

const BROWSER = /firefox|navigator|librewolf|waterfox|chrom|brave|vivaldi|opera|msedge|microsoft-edge|zen/i;
const SELF = /twindesk|macshare|electron/i;
const SHELL = /^(gnome-shell|plasmashell|xfdesktop|xfce4-panel|nautilus-desktop|desktop_window|gjs)$/i;

const SCRIPT = String.raw`
import json, re, sys
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:
    Atspi = None
HOST = re.compile(r'^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#]|$)|^localhost(:\d+)?([/?#]|$)', re.I)
BROWSER = re.compile(sys.argv[1], re.I)
def norm(v):
    v = (v or '').strip()
    if v.lower().startswith('file://'):
        return v
    if not v or ' ' in v:
        return ''
    if re.match(r'^https?://', v, re.I):
        return v
    return 'https://' + v if HOST.match(v) else ''
def active():
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if not a:
            continue
        for j in range(a.get_child_count()):
            w = a.get_child_at_index(j)
            if w and w.get_state_set().contains(Atspi.StateType.ACTIVE):
                return a, w
    return None, None
def text(o):
    try:
        return Atspi.Text.get_text(o, 0, Atspi.Text.get_character_count(o)) or ''
    except Exception:
        return ''
def address(w):
    q = [(w, 0)]
    seen = 0
    while q and seen < 600:
        o, depth = q.pop(0)
        seen += 1
        try:
            role = o.get_role()
        except Exception:
            continue
        if role in (Atspi.Role.DOCUMENT_WEB, Atspi.Role.DOCUMENT_FRAME):
            continue
        if role == Atspi.Role.ENTRY:
            if not o.get_state_set().contains(Atspi.StateType.FOCUSED):
                u = norm(text(o))
                if u:
                    return u
            continue
        if depth >= 14:
            continue
        try:
            n = o.get_child_count()
        except Exception:
            continue
        for k in range(min(n, 200)):
            c = o.get_child_at_index(k)
            if c:
                q.append((c, depth + 1))
    return ''
for line in sys.stdin:
    out = None
    try:
        if Atspi:
            a, w = active()
            if w:
                out = {'app': a.get_name() or '', 'title': w.get_name() or ''}
                if BROWSER.search(out['app']):
                    out['url'] = address(w)
    except Exception:
        out = None
    sys.stdout.write(json.dumps(out) + '\n')
    sys.stdout.flush()
`;

// The Python side: one line asked, one answered.
class Atspi {
  constructor() {
    this.proc = null;
    this.waiting = [];
    this.buf = '';
    this.dead = false;
  }

  ask() {
    if (this.dead) return Promise.resolve(null);
    if (!this.proc) {
      this.proc = spawn('python3', ['-u', '-c', SCRIPT, BROWSER.source], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.proc.on('error', () => { this.dead = true; this._flush(); });
      this.proc.on('exit', () => { this.proc = null; this._flush(); });
      this.proc.stdout.on('data', (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          const fn = this.waiting.shift();
          if (fn) { try { fn(JSON.parse(line)); } catch (_) { fn(null); } }
        }
      });
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => { const k = this.waiting.indexOf(done); if (k >= 0) this.waiting.splice(k, 1); resolve(null); }, 4000);
      const done = (v) => { clearTimeout(t); resolve(v); };
      this.waiting.push(done);
      try { this.proc.stdin.write('{}\n'); } catch (_) { done(null); }
    });
  }

  _flush() {
    for (const fn of this.waiting.splice(0)) fn(null);
  }

  stop() {
    if (this.proc) this.proc.kill();
    this.proc = null;
  }
}

// Recently used files (GTK's and KDE's list), newest first.
let recent = { at: 0, list: [] };
function recentFiles() {
  const f = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'recently-used.xbel');
  let st;
  try { st = fs.statSync(f); } catch (_) { return []; }
  if (st.mtimeMs === recent.at) return recent.list;
  const xml = fs.readFileSync(f, 'utf8');
  const list = [];
  for (const m of xml.matchAll(/<bookmark\b([^>]*)>/g)) {
    const href = /\bhref="([^"]+)"/.exec(m[1]);
    const when = /\b(?:modified|visited)="([^"]+)"/.exec(m[1]);
    if (!href || !href[1].startsWith('file://')) continue;
    try { list.push({ path: decodeURIComponent(new URL(href[1].replace(/&amp;/g, '&')).pathname), at: Date.parse(when ? when[1] : '') || 0 }); } catch (_) { /* not a path */ }
  }
  recent = { at: st.mtimeMs, list: list.sort((a, b) => b.at - a.at).slice(0, 80) };
  return recent.list;
}

// KDE's own list (Dolphin, Okular, Gwenview): one .desktop file per document, URL=file:///….
let kde = { at: 0, list: [] };
function kdeRecent() {
  const d = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'RecentDocuments');
  let st;
  try { st = fs.statSync(d); } catch (_) { return []; }
  if (st.mtimeMs === kde.at) return kde.list;
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.desktop')); } catch (_) { names = []; }
  for (const n of names) {
    try {
      const f = path.join(d, n);
      const m = /^URL(?:\[\$e\])?=(.+)$/m.exec(fs.readFileSync(f, 'utf8'));
      const p = m && docfind.fileUrlPath(m[1].trim(), 'linux');
      if (p) rows.push({ path: p, at: fs.statSync(f).mtimeMs });
    } catch (_) { /* gone meanwhile */ }
  }
  kde = { at: st.mtimeMs, list: rows.sort((a, b) => b.at - a.at).slice(0, 80) };
  return kde.list;
}

function docOf(title, app) {
  const t = docfind.clean(title);
  const recents = recentFiles().concat(kdeRecent()).sort((a, b) => b.at - a.at).map((r) => r.path);
  return docfind.nameMatch(t, recents) || docfind.playerFile(app, t, 'linux')
    || docfind.inFolders(t, recents.slice(0, 16).map((p) => path.dirname(p)));
}

// An app's icon: its .desktop file's Icon, a PNG of the icon theme.
const DESKTOP_DIRS = [path.join(os.homedir(), '.local', 'share', 'applications'), '/usr/share/applications', '/usr/local/share/applications',
  '/var/lib/flatpak/exports/share/applications', path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), '/var/lib/snapd/desktop/applications'];
const ICON_DIRS = [path.join(os.homedir(), '.local', 'share', 'icons'), '/usr/share/icons', '/var/lib/flatpak/exports/share/icons', path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'icons')];
function iconFile(app) {
  const want = String(app || '').toLowerCase();
  if (!want) return '';
  let icon = '';
  for (const d of DESKTOP_DIRS) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith('.desktop')); } catch (_) { continue; }
    for (const n of names) {
      const base = n.slice(0, -8).toLowerCase();
      let text = '';
      const byName = base === want || base.endsWith('.' + want);
      if (!byName) {
        try { text = fs.readFileSync(path.join(d, n), 'utf8'); } catch (_) { continue; }
        const wm = /^StartupWMClass=(.+)$/m.exec(text);
        if (!wm || wm[1].trim().toLowerCase() !== want) continue;
      } else {
        try { text = fs.readFileSync(path.join(d, n), 'utf8'); } catch (_) { continue; }
      }
      const m = /^Icon=(.+)$/m.exec(text);
      if (m) { icon = m[1].trim(); break; }
    }
    if (icon) break;
  }
  if (!icon) return '';
  if (path.isAbsolute(icon)) return /\.png$/i.test(icon) && fs.existsSync(icon) ? icon : '';
  for (const root of ICON_DIRS) {
    for (const theme of ['hicolor']) {
      for (const size of ['256x256', '128x128', '96x96', '64x64', '48x48']) {
        const p = path.join(root, theme, size, 'apps', icon + '.png');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  const pix = path.join('/usr/share/pixmaps', icon + '.png');
  return fs.existsSync(pix) ? pix : '';
}

function create({ helper }) {
  const atspi = new Atspi();
  return {
    async detect() {
      let app = '';
      let title = '';
      let url = '';
      if (helper && helper.backend === 'x11') {
        const w = await helper.request('activeWindow').catch(() => null);
        if (!w || !w.wid || w.desktop) return null;
        app = w.cls || w.inst || w.app || '';
        title = w.title || '';
        if (BROWSER.test(app)) {
          const r = await atspi.ask();
          if (r && r.url && (!r.title || r.title === title)) url = r.url; // the same window
        }
      } else {
        const r = await atspi.ask();
        if (!r) return null;
        app = r.app;
        title = r.title;
        url = r.url || '';
      }
      if (!app || SELF.test(app) || SHELL.test(app)) return null;
      const t = tabs.splitTitle(title);
      const appName = t.app || app;
      if (BROWSER.test(app)) {
        url = url || (tabs.tabOf(app, title) || {}).url || '';
        const local = docfind.fileUrlPath(url, 'linux');
        if (local) return fs.existsSync(local) ? { kind: 'doc', path: local, title: path.basename(local), app, appName } : null; // a PDF in the browser
        return url ? { kind: 'web', url, title: t.page, app, appName } : null; // a browser: its link only
      }
      const doc = docOf(title, app);
      return doc ? { kind: 'doc', path: doc, title: path.basename(doc), app, appName } : { kind: 'app', title: title || appName, app, appName };
    },
    async appIcon(app) {
      const f = iconFile(app);
      if (!f) return '';
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromPath(f);
      return img.isEmpty() ? '' : img.resize({ width: 64, height: 64 }).toDataURL();
    },
    stop: () => atspi.stop(),
  };
}

module.exports = { create, docOf, recentFiles };
