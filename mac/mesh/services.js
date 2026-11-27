// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Creates the helper-backed services and wires them together: display, stream, Monitor 2 input,
// clipboard, shared cursor/keyboard. Restarts the helper if it dies and keeps the display
// awake while a device is connected. The pooled features (clipboard, notifications) talk to the
// mesh through the hub's bus (docs/mesh.md); the one-to-one features get `server` (peer.js).
'use strict';

const { powerSaveBlocker } = require('electron');
const { Helper } = require('./helper'); // Multi-device's helper (several watched edges), else the one-to-one one
const { Displays } = require('./displays');
const { Stream } = require('./stream');
const { StreamSet } = require('./streams');
const { Input } = require('../input');
const { Clip } = require('./clipboard');
const { Kvm } = require('./kvm');
const { Terminal } = require('../terminal');
const { Drop } = require('../drop');
const { Smb } = require('../smb');
const { SmbSet } = require('./smbset');
const { Apps } = require('../apps');
const { SshClient } = require('../ssh-client');
const { AudioHub } = require('../audiohub');
const { Audio } = require('../audio');
const { FileSend } = require('../filesend');
const { PcView } = require('../pcview');
const { PcApps } = require('../pcapps');
const { Notifs } = require('./notifs');
const { FileClip } = require('../fclip');
const MeshFileClip = require('../../shared/fclip-mesh.js').meshFileClip(FileClip, { mac: true });
const { DropSet } = require('./dropset');
const { SendSet } = require('./sendset');
const { Wake } = require('../wake');
const { AppSend } = require('../appsend');
const { Peer } = require('./peer');
const { AudioSet } = require('./audioset');
const store = require('./store');
const P = require('../../shared/protocol.js');

// hub: the mesh hub (hub.js) for the pooled features; mesh: the shared/mesh.js registry; selfName():
// this Mac's name, sent with its notifications; consent: shared/consent.js, each device's own two-way switches.
function startServices({ server, getSettings, pushState, onHelperReady, hub: meshHub, mesh, layoutSync, selfName = () => '', consent = null }) {
  const s = getSettings;
  server.setMaxListeners(50); // one 'client'/'closed' listener per feature
  const helper = new Helper();
  const displays = new Displays(helper, s);
  const hub = new AudioHub(helper, s);
  const stream = new StreamSet({ hub: meshHub, server, displays, make: (peer) => new Stream(peer, displays, s, hub) }); // one Stream per connected device
  let kvm = null;
  // Stream input only when "Receive input" is on and shared input is home.
  const input = new Input(server, helper, displays, {
    enabled: () => s().streamInput !== false && (!kvm || kvm.mode === 'home'),
    swapKeys: () => server.keySwap(s()), // never between two Macs
  });
  const clipboard = new Clip({ bus: meshHub.bus, mesh, getSettings: s, helper, consent, session: (id) => meshHub.sessions.get(id) });
  // Files from every device, each on its own peer: the computer driving this Mac isn't selected here (dropset.js).
  const drop = new DropSet({
    hub: meshHub, server, make: (peer, id) => new Drop({ server: peer, helper, displays, getSettings: s, accepts: consent ? () => consent.get(id, 'files', 'in') : null }),
    partner: () => (kvm && kvm.mode === 'driven' ? kvm.partner : null),
  });
  // Sending: a FileSend per device (sendset.js), so a crossing mid-send doesn't stop it.
  const fileSend = new SendSet({
    hub: meshHub, server, FileSend, getSettings: s, outboxFile: require('path').join(require('electron').app.getPath('userData'), 'outbox.json'),
    partner: () => (kvm && kvm.mode === 'driving' ? kvm.partner : null),
  });
  kvm = new Kvm({ hub: meshHub, layoutSync, helper, getSettings: s, clipboard, input, drop, fileSend });
  require('../../shared/applog.js').linkStats(() => kvm.linkSample()); // the link's line in the log every 30 s
  const terminal = new Terminal(server, s);
  const smb = new SmbSet({ Smb, hub: meshHub, helper, getSettings: s, saveSettings: () => store.saveSettings(s()) }); // a folder per device, this Mac's to all (smbset.js)

  const apps = new Apps({ server, helper, displays, stream, getSettings: s });
  const sshClient = new SshClient(server, s);
  const audioPeer = new Peer(meshHub.audioRoute(), meshHub.server);
  // Sound: an Audio per device, both ways at once (audioset.js); the audio route stays the microphone's.
  const audio = new AudioSet({ Audio, Peer, hub: meshHub, audioHub: hub, stream, getSettings: s });
  // Monitor 2 (another computer's screen here): its own route, as on Windows and Linux (hub.sticky). While
  // its window is open it stays with the device it shows, so a crossing that changes the selection doesn't
  // end the picture; open and showing nothing, it follows a device that starts sharing (#256); closed, it
  // follows the selection again.
  let pcViewRef = null;
  let viewTo = null;
  const viewRoute = meshHub.route((h) => {
    const at = viewTo ? h.sessions.get(viewTo) : null;
    const keep = !!(pcViewRef && pcViewRef.isOpen && at && at.connected);
    viewTo = keep ? viewTo : h.selectedId;
    return viewTo;
  });
  const pcView = new PcView({ server: new Peer(viewRoute, meshHub.server), getSettings: s, saveSettings: () => store.saveSettings(s()) });
  pcViewRef = pcView;
  pcView.on('change', () => setImmediate(() => viewRoute.refresh())); // closed: it follows the selection again (later: never inside a move)
  meshHub.bus.on(P.T.SCREEN_STATE, (m, from) => {
    if (m.on !== true || from === viewRoute.targetId || !pcView.isOpen || pcView.session) return;
    const x = meshHub.sessions.get(from);
    if (!x || !x.connected || P.isPhoneOs(x.peerOs)) return;
    console.log(`[screen] Monitor 2 follows ${x.displayName()}: it shares its screen`);
    meshHub.select(from);
    viewTo = from; // open, it doesn't follow the selection by itself
    viewRoute.refresh();
  });
  const pcApps = new PcApps({ server, getSettings: s });
  const notifs = new Notifs({ bus: meshHub.bus, mesh, helper, getSettings: s, consent, saveSettings: () => store.saveSettings(s()), selfName });
  // History › Keep history: the clipboard's and notifications' history kept, encrypted (shared/histkeeper.js).
  const history = new (require('../../shared/histkeeper.js').HistoryKeeper)({ dir: require('electron').app.getPath('userData'), clip: clipboard, notifs, changed: pushState });
  // Copy and paste files with the shortcuts, with every device (shared/fclip-mesh.js): a paste another
  // device asks for goes to it through a FileSend on its own peer.
  const fileClip = new MeshFileClip({
    hub: meshHub, files: drop, helper, fileSend, getSettings: s,
    makeSender: (id) => fileSend.unit(id),
  });
  kvm.fileClip = fileClip;
  fileClip.kvm = kvm; // the shortcut while the pointer is over there (keyboard not shared)
  // This Mac's apps on another Mac, and Move windows: the selected device's, except while windows are moved
  // out: they stay with the device they went to until they're back, or it goes (#313: a pointer visit to a
  // third device took them home, and their copies there froze).
  let appSendRef = null;
  let appsTo = null;
  const appsRoute = meshHub.route((h) => {
    const s = appsTo ? h.sessions.get(appsTo) : null;
    const keep = !!(appSendRef && appSendRef.moved && appSendRef.moved.size && s && s.connected);
    appsTo = keep ? appsTo : h.selectedId;
    return appsTo;
  });
  const appSend = new AppSend({ server: new Peer(appsRoute, meshHub.server), helper, getSettings: s });
  appSendRef = appSend;
  appSend.on('change', () => appsRoute.refresh()); // windows back: it follows the selection again
  const wake = new Wake({ server, getSettings: s, saveSettings: () => store.saveSettings(s()) });
  kvm.blockEdge = () => pcView.focused || pcApps.focused; // moving inside the PC window never crosses to the PC

  for (const x of [stream, clipboard, kvm, terminal, drop, fileSend, smb, apps, sshClient, audio, pcView, pcApps, notifs, fileClip, wake, appSend]) x.on('change', pushState);
  displays.on('change', () => {
    input.releaseAll(); // the shared display moved or changed size mid-press
    pushState();
  });

  // Helper lifecycle: (re)create the virtual display and restart the stream after every start.
  helper.on('ready', () => {
    displays.applyVirtual().then(() => stream.restart('helper started'));
    onHelperReady();
    pushState();
  });
  const exits = [];
  helper.on('exit', () => {
    pushState();
    if (helper.stopping) return;
    const now = Date.now();
    exits.push(now);
    while (exits.length && now - exits[0] > 30000) exits.shift();
    const delay = exits.length <= 2 ? 1000 : exits.length <= 5 ? 3000 : 10000;
    console.log(`[services] helper exited — restarting in ${delay / 1000} s`);
    setTimeout(() => helper.start(), delay);
  });

  // Keep the display awake while a PC is connected.
  let blocker = null;
  function updateAwake() {
    const want = s().app.keepAwake !== false && !!server.current;
    if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!want && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  }
  server.on('client', updateAwake);
  server.on('closed', updateAwake);

  helper.start();

  return {
    helper, displays, stream, input, clipboard, kvm, terminal, drop, smb, apps, sshClient, audio, audioPeer, pcView, pcApps, hub, fileSend, notifs, history, fileClip, wake, appSend, updateAwake,
    shutdown() {
      pcView.shutdown();
      pcApps.shutdown();
      appSend.shutdown();
      kvm.shutdown();
      hub.shutdown(); // unmute this Mac if we muted it while sending
      stream.stop('off');
      helper.stop(); // closes stdin: the helper exits and the virtual display goes away
    },
  };
}

module.exports = { startServices };
