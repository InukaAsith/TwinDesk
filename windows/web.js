// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web on this PC (shared/web/webwire.js), for main.js and Multi-device's mesh/main.js alike:
// this PC's screen (and the virtual monitor for Extend), its sound (Windows' loopback), input through
// the helper, the Remote page, notifications, the shared folder, media keys, the virtual camera and
// the file-paste shortcut.
// setupWeb(c): c.settings(), c.save(), c.pushState(), c.t, c.device() → {id, name}, c.helper, c.smb,
//   c.notifs, c.fileClip, c.vdd? and c.pcScreen? (Extend), c.kvm() (home or not), c.devctl(),
//   c.loadVcam?(). Returns webwire's {hub, view(), actions, shutdown()}; the actions are ipc handlers.
'use strict';

const os = require('os');
const path = require('path');
const { app, ipcMain, shell, Notification, screen: displays } = require('electron');
const P = require('../shared/protocol.js');
const { receivedDir } = require('../shared/received.js');
const { DevLocal } = require('../shared/devlocal.js');
const { startWeb, pcShare } = require('../shared/web/webwire.js');
const RemoteInput = require('./remote-input');

const apple = (c) => !!c && ['ios', 'ipados', 'mac'].includes(c.os);

function setupWeb(c) {
  const { PhoneRemote } = require('../shared/phone-remote.js');
  const settings = c.settings;
  const helper = c.helper;
  const home = () => { const k = c.kvm(); return !k || k.mode === 'home'; };
  let web = null;
  const { share, smbInfo } = pcShare(c.smb, () => (web ? web.hub.host : os.hostname()));
  const vdd = c.vdd;
  let extending = false; // the virtual monitor is the web device's
  web = startWeb({
    dir: app.getPath('userData'), root: path.join(__dirname, '..'), t: c.t,
    settings, save: c.save, pushState: c.pushState,
    self: () => ({ id: c.device().id, name: c.device().name, os: 'win', version: app.getVersion() }),
    receivedDir: () => receivedDir(settings(), app.getPath('downloads')),
    say: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      try {
        const n = new Notification({ title, body });
        if (onClick) n.on('click', onClick);
        n.show();
      } catch {}
    },
    reveal: (p) => shell.showItemInFolder(p),
    open: (p) => shell.openPath(p),
    capture: { audio: 'loopback' },
    // Extend: the virtual monitor (vdd.js), in the web device's shape, while Share screen isn't using it.
    extend: vdd ? {
      can: () => !!vdd.state.installed && (extending || ((!c.pcScreen || c.pcScreen.mode !== 'extend') && !vdd.state.on)),
      async display(dev) {
        let [w, h] = dev && dev.w > 0 && dev.h > 0 ? [dev.w / 2, dev.h / 2] : [1920, 1080];
        const k = Math.max(1, 720 / Math.min(w, h)); // Windows takes no monitor under 640 × 480
        [w, h] = [Math.round((w * k) / 2) * 2, Math.round((h * k) / 2) * 2];
        extending = true;
        vdd.addMode(w, h);
        const mon = await vdd.setOn(true).catch(() => null);
        if (!mon || !mon.name) { extending = false; return null; }
        const now = (await vdd.setMode(mon, w, h).catch(() => mon)) || mon;
        return displays.getAllDisplays().find((d) => { const r = displays.dipToScreenRect(null, d.bounds); return r.x === now.x && r.y === now.y; }) || null;
      },
      release() {
        if (!extending) return;
        extending = false;
        vdd.setOn(false).catch(() => {});
      },
    } : null,
    // The viewer's mouse, keyboard and pen, aimed at the display it watches (the helper's screen pixels).
    input: (bus, target) => {
      const ri = new RemoteInput({
        link: { get peerOs() { return apple(bus.current) ? P.OS.MAC : P.OS.WIN; } },
        helper,
        settings: { pcScreen: { input: true }, get keys() { return settings().keys; } },
        inputAllowed: () => settings().web.control !== false && home(),
      });
      const at = (r, x, y) => ({ x: Math.round(r.x + x * (r.width - 1)), y: Math.round(r.y + y * (r.height - 1)) });
      for (const ty of RemoteInput.TYPES) bus.on(`t:${ty}`, (m) => {
        if (m.wid != null) return;
        const d = target();
        if (!d) return;
        const r = displays.dipToScreenRect(null, d.bounds);
        ri.handle(m, (x, y) => helper.send('moveTo', at(r, x, y)), null, (x, y, pen) => helper.send('pen', { ...at(r, x, y), pen }));
      });
      bus.on('closed', () => ri.release());
      return ri;
    },
    remote: (bus, getSettings) => new PhoneRemote({ server: bus, helper, getSettings, atHome: home, onChange: c.pushState,
      loadPad: () => require('./gamepad'), save: c.save }),
    notifs: c.notifs && c.notifs.want ? c.notifs : null,
    devLocal: (c.devctl() && c.devctl().local) || new DevLocal(),
    smbInfo,
    share,
    key: (code) => {
      helper.send('inject', { ev: { t: P.T.K_KEY_DOWN, code } });
      helper.send('inject', { ev: { t: P.T.K_KEY_UP, code } });
    },
    vcam: c.loadVcam || null,
    fileClip: c.fileClip && c.fileClip.offerLocal ? c.fileClip : null,
  });
  for (const [name, fn] of Object.entries(web.actions)) ipcMain.handle(name, (_e, arg) => fn(arg));
  return web;
}

module.exports = { setupWeb };
