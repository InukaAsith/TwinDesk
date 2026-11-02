// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Actions from the control window (and the menu bar): validate, save settings, apply.
'use strict';

const { ipcMain, shell, app, screen, dialog, clipboard, Menu } = require('electron');
const P = require('../../shared/protocol.js');
const CL = require('../../shared/cursorlock.js');
const { LINKS } = require('../../shared/about.js');
const store = require('./store');
const { planConnect, settleConnect, sessionIsUp } = require('../connect-plan');

const SETTINGS_URLS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  localNetwork: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  bluetooth: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth',
  location: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices',
  extensions: 'x-apple.systempreferences:com.apple.ExtensionsPreferences?Sharing',
};
const TABS = ['phone', 'overview', 'connection', 'mirror', 'papps', 'calls', 'messages', 'media', 'pfiles', 'share', 'receive', 'cursor', 'keyboard', 'clipboard', 'notifications', 'files', 'mount', 'terminal', 'audio', 'apps', 'multi', 'general', 'about'];

const bool = (v) => !!v;
const clamp = (lo, hi, dflt) => (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const oneOf = (list, dflt) => (v) => (list.includes(v) ? v : dflt);
// A global shortcut: at least Control, Option or Command, plus one key (Electron accelerator).
const KEY = /^(?:(?:Control|Alt|Shift|Command)\+){1,4}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Enter|Up|Down|Left|Right|[`\-=[\];',./\\])$/;
const accel = (dflt) => (v) => (typeof v === 'string' && KEY.test(v) && /Control|Alt|Command/.test(v) ? v : dflt);

// Allowed keys and their validators, per settings group.
const SCHEMA = {
  virtual: { enabled: bool, width: (v) => Math.round(clamp(640, 3840, 1920)(v)), height: (v) => Math.round(clamp(480, 2160, 1080)(v)), hiDPI: bool, hz: oneOf([30, 60], 60) },
  kvm: {
    pcSide: oneOf(P.SIDES, 'right'), mouse: bool, keyboard: bool, driveOther: bool, beDriven: bool,
    resistancePx: (v) => Math.round(clamp(0, 400, 120)(v)), speed: clamp(0.25, 4, 1), reverseScroll: bool, hotkeySwitch: bool, linked: bool, gestures: bool, ble: bool,
  },
  keys: { swapCtrlCmd: bool, hotkey: oneOf(P.HOTKEYS, 'AltRight'), lockKeys: (v) => CL.validKeys(v, CL.DEFAULT_KEYS.mac) },
  app: { openAtLogin: bool, keepAwake: bool, hud: bool },
  mesh: { autoJoin: bool },
  updates: { auto: bool, skipped: (v) => (typeof v === 'string' ? v.slice(0, 40) : '') },
  audio: { send: bool, receive: bool, muteLocal: bool, volume: clamp(0, 1, 1), phoneMedia: bool },
  terminal: { allowPc: bool, connectPc: bool },
  files: { acceptDrops: bool, reveal: bool, dragEdge: bool, shortcuts: bool, copyKeys: accel('Control+Alt+C'), pasteKeys: accel('Control+Alt+V') },
  notifs: { send: bool, receive: bool, hideText: bool },
  smb: { connectPc: bool },
  apps: { offer: bool },
  receive: { on: bool, fullScreen: bool, input: bool, framegen: bool },
  sharing: { remote: bool, pace: oneOf(['fast', 'smooth'], 'fast') },
  papps: { on: bool },
  phone: { sound: bool, bitrateMbps: (v) => Math.round(clamp(2, 40, 8)(v)), maxSize: oneOf([0, 1920, 1600, 1280, 1024], 0), wallpaper: bool, input: oneOf(['adb', 'phone'], 'adb'), inputPicked: bool, enterSends: bool, arrowSwipe: bool },
  mount: { on: bool },
  clipboard: {
    enabled: bool, send: bool, receive: bool, mode: oneOf(['switch', 'instant'], 'instant'),
    skipConcealed: bool, maxKB: oneOf([16, 64, 256], 256), historySize: (v) => Math.round(clamp(0, 100, 20)(v)), images: bool,
  },
};

function setupIpc(ctx) {
  const { settings, pushState } = ctx;

  function save() {
    store.saveSettings(settings);
    pushState();
  }

  function setGroup(group, partial) {
    const schema = SCHEMA[group];
    for (const [k, v] of Object.entries(partial || {})) if (schema[k]) settings[group][k] = schema[k](v);
    save();
  }

  // "Connect by address" / Pair on a found device: a computer that dials us is invited,
  // a computer this Mac dials (a Mac, Windows or Linux host) is dialled.
  const connect = ctx.state.connect;
  const report = (message, error = false, pending = null) => {
    Object.assign(connect, { busy: false, message, error, pending });
    pushState();
  };
  const up = (id) => {
    const clients = ctx.server.server && ctx.server.server.clients ? [...ctx.server.server.clients.values()] : [];
    const authedHostIds = [];
    if (ctx.link && ctx.link.list) {
      for (const l of ctx.link.list()) if (l && l.authed && l.pairing) authedHostIds.push(l.pairing.macId);
    }
    return sessionIsUp(id, { current: ctx.server && ctx.server.current, clients, authedHostIds });
  };
  // The pending "Asked … / Connecting …" hint ends when that device's session is up.
  ctx.server.on('client', (client) => {
    const next = settleConnect(connect, client);
    if (!next) return;
    Object.assign(connect, next);
    pushState();
  });
  async function connectTo(dev, address) {
    const { discovery, pairing } = ctx;
    const link = ctx.link; // the guest links (links.js): one per host
    const plan = planConnect({
      dev,
      address,
      pairedIds: pairing.list().map((p) => p.id),
      hosts: link.hosts || [],
    });
    // Already on this socket: leave the live session alone (the hint was stuck on "Asked …").
    if (plan.id && up(plan.id)) return report('');
    if (plan.action === 'phone') {
      report('');
      return ctx.phone.connect(plan.id);
    }
    if (plan.action === 'invite') {
      discovery.invite(plan.address);
      if (plan.inviting) { // the popup says Pair has to be pressed on the phone, for a minute at most
        const inv = { id: plan.id, name: plan.name };
        connect.inviting = inv;
        setTimeout(() => { if (connect.inviting === inv) { connect.inviting = null; pushState(); } }, 60 * 1000);
      }
      return report(plan.message, false, plan.pending);
    }
    if (plan.action === 'dial') {
      const l = link.get(plan.id);
      if (l) {
        if (plan.address && l.pairing && l.pairing.address !== plan.address) {
          l.pairing.address = plan.address;
          if (plan.port) l.pairing.port = plan.port;
          if (l.store) l.store.save(l.pairing);
        }
        // A host we dial: if it is also connected to us (it dials us), that socket goes first, then we dial.
        const inbound = ctx.server.server.clients.get(plan.id);
        if (inbound) {
          ctx.server.server.release(inbound);
          setTimeout(() => l.connect(true), 800);
        } else l.connect(true);
        return report(plan.message, false, plan.pending);
      }
    }
    report('');
    link.startPairing({ address: plan.address, port: plan.port || P.PORT, macName: plan.name });
  }

  const actions = {
    async connectAddress(text) {
      const address = String(text || '').trim();
      if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(address)) return report('Type an address like 192.168.1.20.', true);
      if (ctx.state.addresses.includes(address)) return report('That’s this Mac.', true);
      Object.assign(connect, { busy: true, message: `Looking at ${address}…`, error: false });
      pushState();
      const dev = await ctx.discovery.ask(address);
      connectTo(dev, address); // no answer: try the WSS port directly (a Mac host answers there)
    },
    connectPhone(deviceId) {
      ctx.phone.connect(String(deviceId));
    },
    disconnectPhone() {
      ctx.phone.disconnect();
    },
    // Disconnect the session (phone or computer); Connect again / Take over the Mac we're a guest of.
    disconnect() {
      if (ctx.server.current && ctx.server.current.os === P.OS.ANDROID) return ctx.phone.disconnect();
      ctx.server.disconnect();
    },
    connectAgain() {
      // Connect again, or Take over, the selected computer (its link)
      const l = ctx.hub.selectedId ? ctx.link.get(ctx.hub.selectedId) : null;
      if (l) l.connect(true);
    },
    setPhone(partial) {
      setGroup('phone', partial);
      if (partial && 'input' in partial) ctx.phone.bridge.tellVia();
    },
    phonePair(arg) {
      if (arg && typeof arg === 'object') ctx.phone.bridge.pair(arg.code, arg.where);
    },
    phoneScreen(open) {
      if (open === false) {
        for (const v of ctx.phoneViews.list()) if (v.kind === 'screen') ctx.phoneViews.close(v.id);
      } else ctx.phoneViews.openScreen();
    },
    phoneOpenApp(arg) {
      if (arg && typeof arg.id === 'string') ctx.phoneViews.openApp(arg.id.slice(0, 200), String(arg.name || '').slice(0, 100));
    },
    phoneCloseView(id) {
      ctx.phoneViews.close(Number(id));
    },
    // Right-click on a phone app: open it, or keep it in the Dock (phoneview.js).
    phoneAppMenu(arg) {
      if (!arg || typeof arg.id !== 'string' || !/^[\w.]{1,200}$/.test(arg.id)) return;
      const name = String(arg.name || arg.id).slice(0, 100);
      Menu.buildFromTemplate([
        { label: 'Open in a Window', click: () => ctx.phoneViews.openApp(arg.id, name) },
        { label: 'Add to Dock', click: () => ctx.phoneViews.pin(arg.id, name) },
      ]).popup();
    },
    phoneInstallFull() {
      ctx.phone.bridge.installFull();
    },
    phoneRetry() {
      ctx.phone.bridge._kick();
    },
    // The phone in Finder (phonedrive.js).
    phoneMount() {
      if (settings.mount.on) ctx.phoneDrive.mount();
    },
    // The Mount page's switch: off unmounts and stops everything (nothing runs until Mount anyway).
    setMount(partial) {
      setGroup('mount', partial);
      if (!settings.mount.on) ctx.phoneDrive.stop();
    },
    phoneUnmount() {
      ctx.phoneDrive.unmount();
    },
    pairWith(deviceId) {
      const dev = ctx.discovery.get(String(deviceId));
      if (dev) connectTo(dev);
    },
    // Devices list: Use makes the device the one the features talk to; Forget removes its pairing.
    selectPeer(deviceId) {
      if (ctx.hub) ctx.hub.select(String(deviceId));
    },
    forgetPeer(deviceId) {
      if (!ctx.hub) return;
      ctx.hub.forgetPeer(String(deviceId));
      ctx.kvm.forgetDevice(String(deviceId)); // it leaves the shared layout too (docs/mesh.md)
      ctx.terminal.forget(String(deviceId));
    },
    confirmGuestCode() {
      ctx.link.confirmCode();
    },
    cancelGuestPair() {
      connect.inviting = null;
      pushState();
      ctx.link.cancelPair();
    },
    forgetHost(hostId) {
      ctx.link.forget(String(hostId));
    },
    refreshDiscovery() {
      ctx.discovery.refresh();
    },
    copyText(text) {
      if (typeof text === 'string' && text.length < 200) clipboard.writeText(text);
    },
    // Ask first (that puts TwinDesk in the System Settings list), then open the pane.
    async allowPermission(kind) {
      if (!SETTINGS_URLS[kind]) return;
      let granted = false;
      if (kind !== 'localNetwork' && ctx.helper.running) {
        try {
          granted = !!(await ctx.helper.request('requestAccess', { kind })).granted;
        } catch {}
      }
      if (!granted) shell.openExternal(SETTINGS_URLS[kind]);
      ctx.refreshPermissions();
    },
    skipSetup(missing) {
      settings.ui.setupSkipped = String(missing || '').slice(0, 200);
      settings.ui.setupDone = true;
      save();
    },
    // by: 'apps' when Mac apps on the PC turned it on/off by themselves; a person's switch ends that.
    setSharing(on, by) {
      if (by !== 'apps' && ctx.apps) ctx.apps.autoShare = false;
      settings.sharing.on = !!on;
      save();
      // Through Bluetooth the picture needs Wi-Fi first (netlink.js); it starts once the session is on it.
      if (on) ctx.net.need('share').then(() => settings.sharing.on && ctx.displays.applyVirtual().then(() => ctx.stream.restart('sharing on')));
      else {
        ctx.net.release('share');
        ctx.stream.stop('off');
        ctx.input.releaseAll();
        ctx.displays.applyVirtual(); // removes the virtual display
      }
    },
    // Who may start our sharing, and smoothness vs. sharpness.
    setSharingOpts(partial) {
      setGroup('sharing', partial);
      ctx.pcView.applySettings(); // playback pace in the open viewer
    },
    // Start/stop the other computer's sharing or switch its Extend/Mirror from here.
    remoteScreen(arg) {
      ctx.pcView.control(arg || {});
    },
    wakePeer(id) {
      ctx.wake.wake(String(id));
      setTimeout(() => ctx.link.poke(), 8000); // a Mac host: try again once it had time to wake
    },
    setWakeOnLan(on) {
      ctx.wake.setWomp(!!on);
    },
    setStreamInput(on) {
      settings.streamInput = !!on;
      save();
      if (!on) ctx.input.releaseAll();
      ctx.server.sendToClient({ t: P.T.STREAM_INPUT, on: !!on }); // Windows goes view-only when off
    },
    // Share this Mac's screen with one device its own way: { mode: 'default'|'none'|'mirror'|'virtual', displayId? }.
    setStreamTarget(id, choice) {
      if (typeof id !== 'string' || !choice || typeof choice !== 'object') return undefined;
      return ctx.stream.setTarget(id, { mode: String(choice.mode), displayId: choice.displayId });
    },
    // null = the TwinDesk virtual display
    selectDisplay(displayId) {
      settings.sharing.displayId = displayId == null ? null : Number(displayId);
      save();
      ctx.stream.restart('display selected');
    },
    // Extend: Monitor 2 is the TwinDesk virtual display. Mirror: it shows this Mac's main screen.
    setDisplayMode(mode) {
      if (mode === 'mirror') {
        settings.sharing.displayId = screen.getPrimaryDisplay().id;
        settings.virtual.enabled = false;
      } else {
        settings.sharing.displayId = null;
        settings.virtual.enabled = true;
      }
      save();
      ctx.displays.applyVirtual().then(() => ctx.stream.restart(`mode ${mode}`));
    },
    setVirtual(partial) {
      setGroup('virtual', partial);
      ctx.displays.applyVirtual();
    },
    setStreamMaxHeight(h) {
      settings.streamMaxHeight = [0, 1080, 1440, 2160].includes(Number(h)) ? Number(h) : 1080;
      save();
      ctx.stream.restart('stream size changed');
    },
    setBitrate(mbps) {
      settings.bitrateMbps = clamp(2, 100, 20)(mbps);
      save();
      ctx.stream.restart('bitrate changed');
    },
    setKvm(partial) {
      const prev = { ...settings.kvm };
      setGroup('kvm', partial);
      ctx.kvm.settingsChanged(prev);
      if (partial && typeof partial.shared === 'boolean') ctx.kvm.setShared(partial.shared); // the Cursor tab's switch (Over Bluetooth through it)
      if (partial && typeof partial.locked === 'boolean') ctx.kvm.setLocked(partial.locked); // cursor lock: not a setting
    },
    // The shared layout (docs/mesh.md): a device goes to a cell (a device there moves to its old cell, or
    // they swap); a device goes off the map. Invalid arguments are ignored; the new layout comes with the state.
    setLayoutCell(arg) {
      const { id, x, y } = arg || {};
      if (typeof id !== 'string' || !id || id.length > 64 || !Number.isInteger(x) || !Number.isInteger(y)) return;
      ctx.layoutSync.place(id, x, y);
    },
    removeFromLayout(id) {
      if (typeof id !== 'string' || !id || id.length > 64) return;
      ctx.layoutSync.remove(id);
    },
    setTerminal(partial) {
      const prev = settings.terminal.connectPc;
      setGroup('terminal', partial);
      ctx.terminal.applySettings();
      if (settings.terminal.connectPc !== prev) ctx.sshClient.applySettings();
    },
    openPcShell() {
      ctx.sshClient.openShell();
    },
    openSharingSettings() {
      shell.openExternal('x-apple.systempreferences:com.apple.Sharing-Settings.extension');
    },
    setFiles(partial) {
      setGroup('files', partial);
      if (partial && ('shortcuts' in partial || 'copyKeys' in partial || 'pasteKeys' in partial)) ctx.fileClip.apply();
      ctx.fileSend.sendPolicy();
      ctx.kvm.config();
    },
    // Send files (paths from the drop zone or the Choose… dialog).
    sendFiles(paths) {
      const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 1000);
      if (list.length && ctx.server.current) ctx.fileSend.sendBatch(list, 'send');
    },
    async chooseSendFiles() {
      const r = await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory', 'multiSelections'], buttonLabel: 'Send' });
      if (!r.canceled) actions.sendFiles(r.filePaths);
    },
    setNotifs(partial) {
      setGroup('notifs', partial);
      ctx.notifs.applySettings();
    },
    muteNotifApp(arg) {
      if (arg && typeof arg.app === 'string') ctx.notifs.setMuted(arg.app.slice(0, 200), !!arg.muted);
    },
    // Full Disk Access has no request API: open the pane and show TwinDesk in Finder to drag in.
    allowFullDisk() {
      shell.openExternal(SETTINGS_URLS.fullDisk);
      const bundle = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
      if (bundle.endsWith('.app')) shell.showItemInFolder(bundle);
    },
    async pickDropFolder() {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use This Folder' });
      if (r.canceled || !r.filePaths[0]) return;
      settings.files.folder = r.filePaths[0];
      save();
    },
    resetDropFolder() {
      settings.files.folder = '';
      save();
    },
    revealDrop(index) {
      ctx.drop.reveal(Number(index));
    },
    setSmb(partial) {
      setGroup('smb', partial);
      if (settings.smb.connectPc) ctx.smb.mountPc();
      else ctx.smb.unmountPc();
    },
    // One switch: on = share the chosen folder (default ~/TwinDesk); off = stop sharing.
    setShareMac(on) {
      if (on) ctx.smb.startSharing();
      else ctx.smb.stopSharing();
    },
    async chooseShareFolder() {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Share This Folder' });
      if (r.canceled || !r.filePaths[0]) return;
      if (settings.smb.sharing) await ctx.smb.stopSharing();
      settings.smb.folder = r.filePaths[0];
      save();
      ctx.smb.startSharing(r.filePaths[0]);
    },
    stopSharingFolder() {
      ctx.smb.stopSharing();
    },
    openPcShare() {
      ctx.smb.openPc();
    },
    setApps(partial) {
      setGroup('apps', partial);
      ctx.apps.applySettings();
      ctx.appSend.applySettings();
    },
    setReceive(partial) {
      setGroup('receive', partial);
      ctx.pcView.applySettings();
    },
    setPcApps(partial) {
      setGroup('papps', partial);
      ctx.pcApps.applySettings();
    },
    listPcApps() {
      ctx.pcApps.list();
    },
    openPcApp(id) {
      ctx.pcApps.open(String(id)); // Wi-Fi first through Bluetooth (main.js)
    },
    keepPcAppInDock(id) {
      ctx.pcApps.keepInDock(String(id));
    },
    showPcView() {
      ctx.net.need('view').then(() => ctx.pcView.show());
    },
    closePcView() {
      ctx.pcView.close();
      ctx.net.release('view');
    },
    // Bluetooth when not on one network (netlink.js, blepipe.js).
    setNet(partial) {
      if (typeof partial.ble === 'boolean') settings.net.ble = partial.ble;
      if (typeof partial.blePc === 'boolean') settings.net.blePc = partial.blePc;
      if (typeof partial.bleWifiOff === 'boolean') settings.net.bleWifiOff = partial.bleWifiOff; // blepolicy.js wifiQuiet
      save();
      ctx.ble.apply();
      if (partial.blePc === false && ctx.bleLook) ctx.bleLook.look(false); // computers off: stop looking now, not at the next tick
      pushState();
    },
    // The banner: the phone's hotspot is on; join it (remembered for that phone).
    netJoinHotspot(arg) {
      const c = ctx.server.current;
      const ssid = String((arg && arg.ssid) || '').trim().slice(0, 32);
      let pass = String((arg && arg.pass) || '').slice(0, 63);
      const saved = c && settings.net.hotspots[c.deviceId];
      if (!pass && saved && saved.ssid === ssid) pass = ctx.netSecret.open(saved.pass);
      if (!ssid || !c) return;
      settings.net.hotspots[c.deviceId] = { ssid, pass: pass ? ctx.netSecret.seal(pass) : '' };
      save();
      ctx.net.joinHotspot(ssid, pass);
    },
    netCancel() {
      ctx.net.cancel();
    },
    // Connect with Wi-Fi Direct (a session on Bluetooth), or with the phone's hotspot (on =
    // 'hotspot'), or back to Bluetooth: the link ends whatever it was made for (the screen too:
    // Bluetooth can't carry it).
    netWifi(on) {
      if (on) return void ctx.net.need(on === 'hotspot' ? 'hotspot' : 'user');
      ctx.net.drop();
      if (settings.sharing.on) actions.setSharing(false);
    },
    setAudio(partial) {
      setGroup('audio', partial);
      ctx.audio.applySettings();
    },
    // "Share sound with the screen" (Display › Mac → PC).
    setScreenSound(on) {
      settings.sharing.audio = !!on;
      save();
      ctx.stream.restart('screen sound');
    },
    // "Join every device automatically" (autojoin.js): off = no introductions asked, granted or accepted.
    setMesh(partial) {
      setGroup('mesh', partial);
      if (settings.mesh.autoJoin !== false && ctx.autoJoin) ctx.autoJoin.schedule();
    },
    setApp(partial) {
      setGroup('app', partial);
      ctx.login.apply(settings.app.openAtLogin);
      ctx.updateAwake();
    },
    setUpdates(partial) {
      setGroup('updates', partial);
      ctx.updates.start();
    },
    skipUpdate(version) {
      if (ctx.updates && ctx.updates.skip) ctx.updates.skip(version);
    },
    unskipUpdate() {
      if (ctx.updates && ctx.updates.unskip) ctx.updates.unskip();
    },
    checkUpdates() {
      ctx.updates.check(true);
    },
    openUpdate() {
      ctx.updates.open();
    },
    openLink(key) { // About page: only its own links, and the log folder
      if (key === 'logs') require('../../shared/applog.js').open();
      else if (Object.hasOwn(LINKS, key)) shell.openExternal(LINKS[key]);
    },
    setKeys(partial) {
      setGroup('keys', partial);
      ctx.kvm.config(); // the hotkey lives in the helper
    },
    setClipboard(partial) {
      setGroup('clipboard', partial);
      ctx.clipboard.applySettings();
    },
    copyHistory(index) {
      ctx.clipboard.copyHistory(Number(index));
    },
    clearHistory() {
      ctx.clipboard.clearHistory();
    },
    // Calls, Messages and Photos (shared/phonehub.js, loaded the first time it's used).
    hub(r) {
      ctx.phoneHub().act(r);
    },
    // Overview: the selected device's controls (shared/devctl.js).
    deviceDo(c) {
      if (c && typeof c === 'object' && ctx.devctl && ctx.devctl()) ctx.devctl().do(c);
    },
    // General › Overview: what Overview shows.
    setOverview(o) {
      if (!o || typeof o !== 'object') return;
      const cur = settings.ui.overview || {};
      for (const k of ['media', 'qs', 'notifs', 'apps', 'clipboard', 'files']) if (typeof o[k] === 'boolean') cur[k] = o[k];
      settings.ui.overview = cur;
      store.saveSettings(settings);
      ctx.pushState();
    },
    // Messages: WhatsApp, Telegram and Instagram there too.
    setChats(on) {
      settings.ui.chats = on === true;
      store.saveSettings(settings);
      if ((ctx.chats && ctx.chats())) (ctx.chats && ctx.chats()).sync();
      ctx.pushState();
    },
    // A phone chat's notification answered here (its own Reply).
    notifReply(r) {
      if (r && typeof r === 'object' && r.chat) return void ((ctx.chats && ctx.chats()) && (ctx.chats && ctx.chats()).reply(String(r.chat), r.text)); // a chat app's conversation (shared/chats.js)
      if (r && typeof r === 'object' && ctx.notifs && ctx.notifs.reply) ctx.notifs.reply(String(r.id || ''), r.text);
    },
    setTab(tab) {
      if (!TABS.includes(tab)) return;
      settings.ui.tab = tab;
      store.saveSettings(settings); // no state push needed; the window already shows it
    },
    pairRespond(allow) {
      ctx.pairing.respond(!!allow);
    },
    forget(deviceId) {
      if (ctx.link.hosts.some((h) => h.id === String(deviceId))) return ctx.link.forget(String(deviceId));
      ctx.pairing.forget(String(deviceId));
      ctx.terminal.forget(String(deviceId));
    },
    openSettings(kind) {
      if (SETTINGS_URLS[kind]) shell.openExternal(SETTINGS_URLS[kind]);
    },
    relaunch() {
      app.relaunch();
      app.exit(0);
    },
    setMulti(on) {
      require('../multi').set(on === true); // Multi-device off: TwinDesk restarts one to one
    },
  };

  ipcMain.handle('getState', () => ctx.state);
  ipcMain.handle('phoneAssets', () => ctx.phone.assetsView());
  for (const [name, fn] of Object.entries(actions)) ipcMain.on(name, (_e, arg) => fn(arg));
  return actions;
}

module.exports = { setupIpc, TABS };
