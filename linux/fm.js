// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The file manager on this desktop, for pastes and drops (fclip.js, dragrecv.js, filerecv.js):
//   front(helper) → {app, title, fm, desktop, folder} for the window in front, or null
//   at(helper)    → the same for the window under the pointer (X11, and KDE's Wayland through KWin;
//                   elsewhere on Wayland the front one)
//   showItems(paths) → the files selected in the file manager
// X11: the helper names the window (activeWindow / windowAt: class, title, GTK's D-Bus object
// path). Wayland has no such query; the accessibility bus (AT-SPI, on by default on GNOME and
// KDE) says which window is active, though not where it is. A window's folder: Nautilus lists what
// its windows show (org.freedesktop.FileManager1 OpenWindowsWithLocations), matched by the
// object path, else by the title; the desktop is the Desktop folder; a title that is a folder's
// absolute path (PCManFM, Caja with the option) is that folder. Python 3 with GObject
// introspection does the D-Bus and AT-SPI part (standard on GNOME, Cinnamon, MATE and Xfce desktops);
// without it nothing is known and callers fall back to Downloads.
// KDE on Wayland: KWin knows which window is under the pointer (a script of ours, loaded for the
// moment over D-Bus, calls us back with it), the desktop is plasmashell's, and Dolphin's title is
// "Folder — Dolphin": with "Show the full path in the title bar" on it is the folder's path; else a
// name, which is the folder when exactly one folder of that name is in the home folder (3 deep).
'use strict';

const { execFile } = require('child_process');

const SCRIPT = String.raw`
import json, os, sys
from urllib.parse import unquote, urlparse
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

FMS = ('nautilus', 'org.gnome.nautilus', 'nemo', 'caja', 'thunar', 'pcmanfm', 'pcmanfm-qt', 'dolphin',
       'org.kde.dolphin', 'spacefm', 'io.elementary.files', 'peony', 'dde-file-manager', 'krusader', 'doublecmd', 'org.gnome.files')
req = json.loads(sys.argv[1])

def path_of(uri):
    u = urlparse(uri)
    return unquote(u.path) if u.scheme == 'file' else ''

def locations():
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        r = bus.call_sync('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.DBus.Properties', 'Get',
                          GLib.Variant('(ss)', ('org.freedesktop.FileManager1', 'OpenWindowsWithLocations')), GLib.VariantType('(v)'), 0, 1500, None)
        return r.unpack()[0]
    except Exception:
        return {}

def display_name(p):
    if os.path.realpath(p) == os.path.realpath(os.path.expanduser('~')):
        return 'Home'
    try:
        return Gio.File.new_for_path(p).query_info('standard::display-name', 0, None).get_display_name()
    except Exception:
        return os.path.basename(p)

# KDE on Wayland: the window under the pointer, from KWin (workspace.stackingOrder, top first).
KWIN_JS = '''
const p = workspace.cursorPos;
let hit = null;
const list = workspace.stackingOrder;
for (let i = list.length - 1; i >= 0; i--) {
  const w = list[i];
  if (!w || w.minimized || w.deleted) continue;
  if (!(w.normalWindow || w.desktopWindow || w.dialog)) continue;
  if (typeof w.isOnDesktop === 'function' ? !w.isOnDesktop(workspace.currentDesktop) : w.onCurrentDesktop === false) continue;
  const g = w.frameGeometry;
  if (p.x >= g.x && p.x < g.x + g.width && p.y >= g.y && p.y < g.y + g.height) { hit = w; break; }
}
callDBus('NAME', '/', 'org.twindesk.Pointer', 'Report', hit ? JSON.stringify({ title: String(hit.caption), cls: String(hit.resourceClass), app: String(hit.resourceName), desktop: !!hit.desktopWindow }) : 'null');
'''

def pointer():
    import tempfile
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    name = 'org.twindesk.Pointer.p%d' % os.getpid()
    xml = '<node><interface name="org.twindesk.Pointer"><method name="Report"><arg type="s" direction="in"/></method></interface></node>'
    got = {'r': None}
    loop = GLib.MainLoop()
    def call(conn, sender, path, iface, method, params, inv):
        got['r'] = params.unpack()[0]
        inv.return_value(None)
        loop.quit()
    bus.register_object('/', Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], call, None, None)
    Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, None, None)
    fd, js = tempfile.mkstemp(suffix='.js')
    os.write(fd, KWIN_JS.replace('NAME', name).encode())
    os.close(fd)
    plugin = 'twindesk-pointer-%d' % os.getpid()
    try:
        sid = bus.call_sync('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'loadScript', GLib.Variant('(ss)', (js, plugin)), GLib.VariantType('(i)'), 0, 1500, None).unpack()[0]
        bus.call_sync('org.kde.KWin', '/Scripting/Script%d' % sid, 'org.kde.kwin.Script', 'run', None, None, 0, 1500, None)
        GLib.timeout_add(1500, loop.quit)
        loop.run()
    finally:
        try:
            bus.call_sync('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', GLib.Variant('(s)', (plugin,)), None, 0, 1500, None)
        except Exception:
            pass
        os.unlink(js)
    w = json.loads(got['r'] or 'null')
    if not w:
        return None
    return {'app': w.get('cls') or w.get('app') or '', 'cls': w.get('cls') or '', 'inst': w.get('app') or '', 'title': w.get('title') or '', 'desktop': bool(w.get('desktop'))}

# A folder name alone (Dolphin's title without the full path): the one folder of that name in the home folder.
def by_name(name):
    home = os.path.expanduser('~')
    if name in ('Home', os.path.basename(home)):
        return home
    hits = []
    for root, dirs, files in os.walk(home):
        if root[len(home):].count(os.sep) >= 3:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        if name in dirs:
            hits.append(os.path.join(root, name))
            if len(hits) > 1:
                return ''
    return hits[0] if hits else ''

def active():
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if not a:
            continue
        for j in range(a.get_child_count()):
            w = a.get_child_at_index(j)
            if w and w.get_state_set().contains(Atspi.StateType.ACTIVE):
                return {'app': a.get_name() or '', 'title': w.get_name() or ''}
    return None

win = req.get('win')
if req.get('mode') == 'pointer':
    try:
        win = pointer()
    except Exception:
        win = None
    req['mode'] = 'active' if not win else ''
if req.get('mode') == 'active':
    try:
        win = active()
    except Exception:
        win = None
if not win:
    print('null')
    sys.exit(0)
title = win.get('title') or ''
names = [str(win.get(k) or '').lower() for k in ('app', 'cls', 'inst')]
desktop = bool(win.get('desktop')) or (names[0] in ('gjs', 'gnome-shell') and title.lower() == 'desktop icons') \
    or names[1] in ('desktop_window', 'xfdesktop') or names[2] == 'desktop_window'
fm = any(n in FMS for n in names)
folder = ''
if desktop:
    folder = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) or os.path.expanduser('~/Desktop')
elif fm:
    locs = locations()
    obj = win.get('object') or ''
    if obj in locs and locs[obj]:
        folder = path_of(locs[obj][0])
    if not folder:
        paths = [p for uris in locs.values() for p in map(path_of, uris[:1]) if p]
        hits = [p for p in paths if display_name(p) == title]
        if len(hits) >= 1:
            folder = hits[0]
    if not folder:
        # "Folder — Dolphin", "Folder – Files", "Folder - Thunar": the folder part.
        t = title
        for sep in (' \u2014 ', ' \u2013 ', ' - '):
            t = t.split(sep)[0]
        t = t.strip()
        if t.startswith('~'):
            t = os.path.expanduser(t)
        if t.startswith('/') and os.path.isdir(t):
            folder = t
        elif t and '/' not in t and any('dolphin' in n for n in names):
            folder = by_name(t)
print(json.dumps({'app': win.get('app') or win.get('cls') or '', 'title': title, 'fm': fm, 'desktop': desktop, 'folder': folder}))
`;

function py(req) {
  return new Promise((resolve) => {
    execFile('python3', ['-c', SCRIPT, JSON.stringify(req)], { timeout: 4000 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(out).trim() || 'null')); } catch (_) { resolve(null); }
    });
  });
}

async function info(helper, cmd) {
  if (helper && helper.backend === 'x11') {
    const w = await helper.request(cmd).catch(() => null);
    if (!w || !w.wid) return null;
    const r = await py({ win: w });
    // No Python: the class alone still says whether it's a file manager.
    return r || { app: w.cls || '', title: w.title || '', fm: /nautilus|nemo|caja|thunar|pcmanfm|dolphin|files/i.test((w.cls || '') + ' ' + (w.app || '')), desktop: !!w.desktop, folder: '' };
  }
  // Wayland: under the pointer where KWin can say (KDE), else the front window.
  if (cmd === 'windowAt' && /kde/i.test(String(process.env.XDG_CURRENT_DESKTOP || ''))) return py({ mode: 'pointer' });
  return py({ mode: 'active' });
}

const front = (helper) => info(helper, 'activeWindow');
const at = (helper) => info(helper, 'windowAt');

// Select the files in the file manager (FileManager1.ShowItems), else open their folder.
function showItems(paths) {
  const { shell } = require('electron');
  const uris = paths.slice(0, 100).map((p) => 'file://' + encodeURI(p).replace(/[?#]/g, encodeURIComponent));
  const arg = '[' + uris.map((u) => "'" + u.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'").join(',') + ']';
  execFile('gdbus', ['call', '--session', '--dest', 'org.freedesktop.FileManager1', '--object-path', '/org/freedesktop/FileManager1',
    '--method', 'org.freedesktop.FileManager1.ShowItems', arg, ''], { timeout: 4000 }, (err) => {
    if (err && paths[0]) shell.showItemInFolder(paths[0]);
  });
}

module.exports = { front, at, showItems };
