// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main-window actions (preload-app.js → here). Every value is validated by settings.apply().
const { ipcMain, dialog, shell, BrowserWindow, clipboard, Menu } = require('electron');
const path = require('path');
const P = require('../shared/protocol.js');
const { LINKS } = require('../shared/about.js');
const { apply } = require('./settings');

// ctx: link, discovery, screen, clip, kvm, terminal, fileDrop, smb, apps, phone, phoneViews, connectPhoneDev(d), settings, save(), push(), buildState(),
//      checkFirewall(), fixFirewall(), setStartup(on)
function setupIpc(ctx) {
  const { link, discovery, screen, clip, kvm, terminal, sshd, fileDrop, smb, apps, sound, pcScreen, pcApps, peerApps, vdd, notifs, fileClip, wake, settings } = ctx;

  const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));
  const change = (section, partial, after) => {
    if (!apply(settings, section, partial)) return;
    ctx.save();
    if (after) after();
    ctx.push();
  };

  handle('getState', () => ctx.buildState());
  // Calls, Messages and Photos (shared/phonehub.js, loaded the first time it's used).
  handle('hub', (r) => ctx.hub().act(r));

  const pairWith = (d) => {
    discovery.clearInvite(d.id);
    if (d.os === P.OS.ANDROID) return ctx.connectPhoneDev(d); // a phone has no server to pair with
    link.startPairing({ address: d.address, port: d.port, macName: d.name, id: d.id }); // id: one met over Bluetooth
  };
  handle('pair', (target) => {
    if (typeof target !== 'string' || !target.trim()) return;
    const found = discovery.get(target) || discovery.near(target);
    if (found) return pairWith(found);
    const m = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(target);
    if (!m) return;
    const port = m[2] ? Number(m[2]) : P.PORT;
    if (port < 1 || port > 65535) return;
    link.startPairing({ address: m[1], port, macName: m[1] });
  });
  // Connect by address: ask who is there (unicast probe works where broadcast is blocked); no
  // answer in PROBE_REPLY_MS → try WSS on that address directly ("No TwinDesk at …" if nothing).
  handle('connectAddress', async (text) => {
    const m = typeof text === 'string' && /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(text);
    if (!m) return;
    const d = m[2] ? null : await discovery.ask(m[1]);
    if (d) return pairWith(d);
    const port = m[2] ? Number(m[2]) : P.PORT;
    if (port >= 1 && port <= 65535) link.startPairing({ address: m[1], port, macName: m[1] });
  });
  handle('refreshFound', () => discovery.refresh());
  handle('copyText', (text) => typeof text === 'string' && text.length < 1000 && clipboard.writeText(text));
  handle('confirmCode', () => link.confirmCode());
  handle('cancelPair', () => { ctx.cancelPhoneInvite(); link.cancelPair(); });
  handle('forget', () => link.forget());
  // Disconnect (either side of the session); Connect again / Take over the computer we're a guest of.
  handle('disconnect', () => link.disconnect());
  handle('connectAgain', () => link.connect(true));
  // Connect on a paired device in our list that connects to us: a phone is asked as usual, a
  // computer is invited and its hello takes the session over.
  handle('connectGuest', (id) => {
    if (typeof id !== 'string') return;
    const d = discovery.get(id) || discovery.near(id);
    if (!d) return;
    if (d.os === P.OS.ANDROID) return ctx.connectPhoneDev(d);
    link.expect(id);
    discovery.invite(d.address);
  });
  handle('respondPair', (allow) => link.respondPair(allow === true)); // host: Allow / Deny
  handle('forgetGuest', (id) => typeof id === 'string' && link.forgetGuest(id));
  handle('wakePeer', (id) => typeof id === 'string' && wake.wake(id));
  handle('setWake', (on) => wake.set(on === true)); // A switch
  handle('checkWake', () => wake.check());
  handle('openMonitor', () => screen.open(false));
  handle('remoteScreen', (arg) => arg && typeof arg === 'object' && screen.control({ share: arg.share, mode: arg.mode })); // screen.ctl

  handle('setKvm', (partial) => {
    if (partial && typeof partial.linked === 'boolean') kvm.setLinked(partial.linked); // home first, tells the other side
    if (partial && typeof partial.shared === 'boolean') kvm.setShared(partial.shared); // the Cursor tab's switch (Over Bluetooth through it)
    const { linked, shared, ...rest } = partial && typeof partial === 'object' ? partial : {};
    change('kvm', rest, () => kvm.applyConfig());
  });
  handle('setLayout', (side) => kvm.setLayout(side));
  handle('setKeys', (partial) => change('keys', partial, () => kvm.applyConfig())); // the hotkey lives in the helper
  handle('setApp', (partial) => change('app', partial, () => ctx.onApp && ctx.onApp()));
  handle('setUpdates', (partial) => change('updates', { auto: !!(partial && partial.auto) }, () => ctx.updates.start()));
  handle('checkUpdates', () => ctx.updates.check(true));
  handle('openUpdate', () => ctx.updates.open());
  handle('openLink', (key) => Object.hasOwn(LINKS, key) && shell.openExternal(LINKS[key])); // About page: only its own links
  handle('setMonitor', (partial) => change('monitor', partial, () => screen.applyAudio()));
  handle('setClipboard', (partial) => change('clipboard', partial, () => clip.applySettings()));
  handle('copyHistory', (index) => clip.copyHistory(Number(index)));
  handle('clearHistory', () => clip.clearHistory());
  handle('setTab', (tab) => change('ui', { tab })); // invalid names fall back in normalize()
  handle('setMulti', (on) => require('./multi').set(on === true)); // Multi-device: TwinDesk restarts
  handle('setAudio', (partial) => change('audio', partial, () => sound.apply()));
  handle('setTerminal', (partial) => {
    const p = partial && typeof partial === 'object' ? { enabled: partial.enabled, allowMac: partial.allowMac } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('terminal', p, () => { terminal.apply(); sshd.apply(); });
  });
  handle('setupSshd', () => sshd.setup());
  handle('openTerminal', () => terminal.open());
  handle('setFiles', (partial) => {
    // shareOn/shareFolder only change through share()/unshare()
    const p = partial && typeof partial === 'object' ? { dropToMac: partial.dropToMac, mountMac: partial.mountMac, acceptFromMac: partial.acceptFromMac, edgeDrag: partial.edgeDrag,
      shortcuts: partial.shortcuts, copyKeys: partial.copyKeys, pasteKeys: partial.pasteKeys } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('files', p, () => { smb.applyMount(); kvm.applyConfig(); fileClip.apply(); });
  });
  // Send files (paths from the drop zone or Choose…), notifications.
  const sendFiles = (paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && path.win32.isAbsolute(p)).slice(0, 1000);
    if (list.length) fileDrop.sendBatch(list, 'send');
  };
  handle('sendFiles', sendFiles);
  handle('chooseSendFiles', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Send files', buttonLabel: 'Send', properties: ['openFile', 'multiSelections'] });
    if (!r.canceled) sendFiles(r.filePaths);
  });
  handle('setNotifs', (partial) => {
    const p = partial && typeof partial === 'object' ? { send: partial.send, receive: partial.receive, hideText: partial.hideText } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('notifs', p, () => notifs.applySettings());
  });
  handle('muteNotifApp', (arg) => arg && typeof arg.app === 'string' && notifs.setMuted(arg.app.slice(0, 300), arg.muted === true));
  handle('clearNotifHistory', () => notifs.clearHistory && notifs.clearHistory());
  handle('openNotifiedApp', (arg) => arg && typeof arg.app === 'string' && phoneViews.openNotified(arg.app, arg.appName));
  handle('setShareOn', (on) => smb.setShareOn(on === true));
  handle('chooseShareFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Folder to share with the other computer', properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) await smb.chooseFolder(r.filePaths[0]);
  });
  handle('removeShare', () => smb.unshare());
  handle('openMacDrive', () => (smb.drive ? shell.openPath(smb.drive + '\\') : smb.openOverWifi && smb.openOverWifi())); // through Bluetooth: Wi-Fi Direct first
  handle('cancelDrop', () => fileDrop.cancel());
  // With another PC the apps come through peerapps.js (no Monitor 2 or Start pinning).
  const pcPeer = () => link.peerOs !== P.OS.MAC; // a PC or a Linux computer
  handle('listApps', () => (pcPeer() ? peerApps.refresh() : apps.refresh()));
  handle('launchApp', (id) => { if (pcPeer()) peerApps.launch(id); else { apps.launch(id); screen.ensureHidden(); } });
  handle('pinApp', (id) => typeof id === 'string' && !pcPeer() && apps.pin(id, true)); // Pin to Start
  handle('setPcScreen', (partial) => {
    const size = settings.pcScreen.extendSize;
    change('pcScreen', partial, () => { pcScreen.applyInput(); if (!settings.pcScreen.input) pcApps.input.release(); if (settings.pcScreen.extendSize !== size) pcScreen.sizeExtend(); else pcScreen.apply(); });
  });
  handle('setMacApps', (partial) => change('macApps', partial, () => peerApps.apply()));
  handle('setPcApps', (partial) => change('pcApps', partial, () => { pcApps.apply(); pcApps.input.release(); }));
  handle('setPcScreenMode', (mode) => pcScreen.setMode(mode));
  // A phone as the peer (phone.js, phone-bridge.js, phoneview.js; there once our server runs)
  const phone = (name, fn) => handle(name, (...args) => (ctx.phone ? fn(...args) : undefined));
  phone('connectPhone', (id) => ctx.phone.connect(String(id)));
  phone('disconnectPhone', () => ctx.phone.disconnect());
  handle('setPhone', (partial) => change('phone', partial, () => partial && 'input' in partial && ctx.phone && ctx.phone.bridge.tellVia()));
  // The phone as a drive (phonedrive.js). The Mount page's switch: off unmounts and stops
  // everything (nothing runs until Mount anyway).
  phone('phoneMount', () => settings.mount.on && ctx.phoneDrive.mount());
  phone('phoneUnmount', () => ctx.phoneDrive.unmount());
  handle('setMount', (partial) => change('mount', partial, () => !settings.mount.on && ctx.phoneDrive && ctx.phoneDrive.stop()));
  phone('phonePair', (arg) => arg && typeof arg === 'object' && ctx.phone.bridge.pair(arg.code, arg.where));
  phone('phoneScreen', (open) => {
    if (open === false) {
      for (const v of ctx.phoneViews.list()) if (v.kind === 'screen') ctx.phoneViews.close(v.id);
    } else ctx.phoneViews.openScreen();
  });
  phone('phoneOpenApp', (arg) => arg && typeof arg.id === 'string' && ctx.phoneViews.openApp(arg.id.slice(0, 200), String(arg.name || '').slice(0, 100)));
  phone('phoneCloseView', (id) => ctx.phoneViews.close(Number(id)));
  // Right-click on a phone app: open it, or pin it to Start (phoneview.js).
  phone('phoneAppMenu', (arg) => {
    if (!arg || typeof arg.id !== 'string' || !/^[\w.]{1,200}$/.test(arg.id)) return;
    const name = String(arg.name || arg.id).slice(0, 100);
    Menu.buildFromTemplate([
      { label: 'Open in a Window', click: () => ctx.phoneViews.openApp(arg.id, name) },
      { label: 'Pin to Start', click: () => ctx.phoneViews.pin(arg.id, name) },
    ]).popup();
  });
  phone('phoneRetry', () => ctx.phone.bridge._kick());
  phone('phoneInstallFull', () => ctx.phone.bridge.installFull());
  handle('phoneAssets', () => (ctx.phone ? ctx.phone.assetsView() : { wallpaper: '', apps: [] }));
  handle('installVdd', () => vdd.install());
  handle('removeVdd', () => vdd.remove());
  handle('skipSetup', () => change('setup', { skipped: ctx.buildState().setup.missing, done: true }));
  handle('checkFirewall', () => ctx.checkFirewall());
  handle('fixFirewall', () => ctx.fixFirewall());
  handle('setStartup', (on) => ctx.setStartup(on === true));
  // Not on the same network: Bluetooth on/off, and giving up on moving to Wi-Fi (netlink.js).
  handle('setNet', (partial) => change('net', partial, () => ctx.applyNet()));
  handle('netCancel', () => ctx.net && ctx.net.cancel());
  handle('netJoinHotspot', (arg) => ctx.joinHotspot(arg));
  handle('netLocation', () => shell.openExternal('ms-settings:privacy-location')); // netsh's Wi-Fi commands need it (wifi.js)
  handle('openBluetoothSettings', () => shell.openExternal('ms-settings:bluetooth'));
  // Connect with Wi-Fi Direct (a session on Bluetooth), or back to Bluetooth (the link ends, whatever it was made for).
  // on = 'hotspot': Connect with hotspot (a phone's; the Overview asks for its name and password).
  handle('netWifi', (on) => {
    if (!ctx.net) return;
    if (on) return void ctx.net.need(on === 'hotspot' ? 'hotspot' : 'user');
    ctx.net.drop();
    if (ctx.pcScreen.mode !== 'off') ctx.pcScreen.setMode('off'); // Bluetooth can't carry the screen
  });

  // pairsync.js applies a value the other computer changed, with the same side effects.
  const AFTER = {
    clipboard: () => clip.applySettings(),
    monitor: () => screen.applyAudio(), // pacing (pair.sync 'pace')
    notifs: () => notifs.applySettings(),
    audio: () => sound.apply(),
    kvm: () => kvm.applyConfig(),
    pcApps: () => { pcApps.apply(); pcApps.input.release(); },
  };
  return { set: (section, partial) => change(section, partial, AFTER[section]) };
}

module.exports = setupIpc;
