// TwinDesk Drive in a computer's app (docs/drive.md): the Files page's switch and folder,
// the engine (shared/drive.js) and the session link (shared/drive-link.js). The app requires this
// only once Drive is on, and the engine and the link only load here, so with Drive off nothing of it
// runs: no watcher, no timer, no index in memory.
//
// create({settings, save, me, meName, userData, trash, adapter, onChange}):
//   settings.drive = {on, folder ('' = ~/TwinDesk Drive)}; save(); me, meName: this device's id and
//   name; userData: the app's folder (the index lives there); trash(abs) -> Promise.
//   adapter: the app's session, {on(type, fn), onUp(fn), onDown(fn), onMoved(fn), send(msg),
//   session() (fast files' {host, token, address, port?, fp?, transport}), peerName(),
//   setRequest(fn | null) (the host's HTTPS requests: fn(req, res) -> handled)}.
//
// createMesh({settings, save, me, meName, userData, trash, mesh, onChange}): the same for Multi-device:
//   one engine, and a link to each connected computer (phones never say drive.hello, so they get none).
//   mesh: the hub's bus, {on(type, fn(msg, fromId)), onPeer('welcome' | 'closed' | 'transport', fn(id)),
//   send(id, msg), session(id) (that device's fast-files session, as above), peerName(id),
//   isComputer(id), connectedIds(), setRequest(fn | null) (our server's HTTPS requests)}.
'use strict';

const os = require('os');
const path = require('path');
const P = require('./protocol.js');

const DRIVE_TYPES = [P.T.DRIVE_HELLO, P.T.DRIVE_INDEX, P.T.DRIVE_UPDATE, P.T.DRIVE_WANT, P.T.DRIVE_GONE];
const defaultFolder = () => path.join(os.homedir(), 'TwinDesk Drive');

function create({ settings, save, me, meName, userData, trash, adapter, onChange = () => {} }) {
  let drive = null, link = null, up = false, hooked = false, error = '';
  const cfg = () => settings.drive || (settings.drive = { on: false, folder: '' });
  const folder = () => cfg().folder || defaultFolder();

  // The session's events go to the link while there is one (registered once: some adapters can't unregister).
  const hook = () => {
    if (hooked) return;
    hooked = true;
    for (const t of DRIVE_TYPES) adapter.on(t, (m) => link && link.onMessage(m));
    adapter.onUp(() => { up = true; if (link) link.start(); onChange(); });
    adapter.onDown(() => { up = false; if (link) link.stop(); onChange(); });
    adapter.onMoved(() => link && link.kick());
  };

  async function start() {
    if (drive) return;
    const { Drive } = require('./drive.js');
    const { DriveLink } = require('./drive-link.js');
    hook();
    drive = new Drive({ me, meName, folder, indexFile: path.join(userData, 'drive-index.json'), trash });
    drive.on('change', onChange);
    link = new DriveLink({ drive, send: (m) => adapter.send(m), session: () => adapter.session(), peerName: () => adapter.peerName(), onChange });
    adapter.setRequest((req, res) => link.request(req, res));
    try {
      await drive.start();
      error = '';
    } catch (e) {
      error = e.message;
    }
    if (up || adapter.session()) link.start();
    onChange();
  }

  async function stop() {
    adapter.setRequest(null);
    if (link) link.destroy();
    link = null;
    const d = drive;
    drive = null;
    if (d) await d.stop();
    onChange();
  }

  const host = {
    async setOn(on) {
      cfg().on = !!on;
      save();
      if (on) await start();
      else await stop();
    },
    // A new folder: the index starts again there (the old folder's files stay where they are).
    async setFolder(f) {
      cfg().folder = typeof f === 'string' ? f : '';
      save();
      if (drive) { await stop(); await start(); }
      onChange();
    },
    folder,
    view() {
      const s = drive ? drive.status() : null;
      const l = link ? link.status() : { connected: false, moving: 0 };
      return {
        on: cfg().on === true, folder: folder(), custom: !!cfg().folder,
        state: s ? s.state : 'off', files: s ? s.files : 0, bytes: s ? s.bytes : 0,
        skipped: s ? s.skipped : 0, conflicts: s ? s.conflicts : 0, lastSync: s ? s.lastSync : 0,
        connected: l.connected, moving: l.moving, peer: l.connected ? adapter.peerName() : '',
        error: error || (s && s.error) || '',
      };
    },
    stop,
  };
  if (cfg().on) start();
  return host;
}

// Multi-device: every connected computer syncs with the one engine here. A change adopted from one
// goes on to the others (the engine's 'changed'), so they all end up the same.
function createMesh({ settings, save, me, meName, userData, trash, mesh, onChange = () => {} }) {
  let drive = null, DriveLink = null, HEADER = '', PATH = '', hooked = false, error = '';
  const links = new Map(); // peer id -> DriveLink, while that computer is connected
  const cfg = () => settings.drive || (settings.drive = { on: false, folder: '' });
  const folder = () => cfg().folder || defaultFolder();

  const open = (id) => {
    if (links.has(id)) return links.get(id);
    if (!drive || !id || !mesh.isComputer(id)) return null;
    const l = new DriveLink({ drive, send: (m) => mesh.send(id, m), session: () => mesh.session(id), peerName: () => mesh.peerName(id), onChange });
    links.set(id, l);
    return l;
  };
  const close = (id) => {
    const l = links.get(id);
    if (!l) return;
    links.delete(id);
    l.destroy();
    onChange();
  };

  // Registered once (the bus can't unregister): with Drive off they find no link and do nothing.
  const hook = () => {
    if (hooked) return;
    hooked = true;
    for (const t of DRIVE_TYPES) {
      mesh.on(t, (m, from) => {
        const l = links.get(from) || (drive && t === P.T.DRIVE_HELLO ? open(from) : null);
        if (l) l.onMessage(m);
      });
    }
    mesh.onPeer('welcome', (id) => { const l = drive && open(id); if (l) l.start(); onChange(); });
    mesh.onPeer('closed', (id) => close(id));
    mesh.onPeer('transport', (id) => { const l = links.get(id); if (l) l.kick(); });
  };

  // Our server's HTTPS: to the link of the host session whose token the request carries.
  const request = (req, res) => {
    if (!req.url.startsWith(PATH)) return false;
    const tok = req.headers[HEADER];
    if (typeof tok === 'string' && tok) {
      for (const [id, l] of links) {
        const s = mesh.session(id);
        if (s && s.host && s.token === tok) return l.request(req, res);
      }
    }
    res.writeHead(403);
    res.end();
    return true;
  };

  async function start() {
    if (drive) return;
    const { Drive } = require('./drive.js');
    ({ DriveLink, HEADER, PATH } = require('./drive-link.js'));
    hook();
    drive = new Drive({ me, meName, folder, indexFile: path.join(userData, 'drive-index.json'), trash });
    drive.on('change', onChange);
    mesh.setRequest(request);
    try {
      await drive.start();
      error = '';
    } catch (e) {
      error = e.message;
    }
    if (!drive) return; // turned off meanwhile
    for (const id of mesh.connectedIds()) { const l = open(id); if (l) l.start(); }
    onChange();
  }

  async function stop() {
    mesh.setRequest(null);
    for (const id of [...links.keys()]) close(id);
    const d = drive;
    drive = null;
    if (d) await d.stop();
    onChange();
  }

  const host = {
    async setOn(on) {
      cfg().on = !!on;
      save();
      if (on) await start();
      else await stop();
    },
    async setFolder(f) {
      cfg().folder = typeof f === 'string' ? f : '';
      save();
      if (drive) { await stop(); await start(); }
      onChange();
    },
    folder,
    view() {
      const s = drive ? drive.status() : null;
      let moving = 0;
      const peers = [];
      for (const [id, l] of links) {
        const st = l.status();
        moving += st.moving;
        if (st.connected) peers.push(mesh.peerName(id));
      }
      return {
        on: cfg().on === true, folder: folder(), custom: !!cfg().folder,
        state: s ? s.state : 'off', files: s ? s.files : 0, bytes: s ? s.bytes : 0,
        skipped: s ? s.skipped : 0, conflicts: s ? s.conflicts : 0, lastSync: s ? s.lastSync : 0,
        connected: peers.length > 0, moving, peer: peers.join(', '),
        error: error || (s && s.error) || '',
      };
    },
    stop,
  };
  if (cfg().on) start();
  return host;
}

// createMesh's `mesh` from a Multi-device hub (windows/, linux/ and mac/mesh/hub.js alike). The server
// comes later than the hub (once the certificate is there): server() is asked again as devices come up.
function hubAdapter(hub, server) {
  let fn = null;
  const sess = (id) => hub.sessions.get(id);
  const hooked = new WeakSet();
  const attach = () => {
    const srv = server();
    if (!srv || hooked.has(srv)) return;
    hooked.add(srv);
    srv.driveRequest = (req, res) => !!fn && fn(req, res);
  };
  return {
    on: (t, f) => hub.bus.on(t, f),
    // A device that dialled us comes up only once the server is there: hooked before its first request.
    onPeer: (ev, f) => hub.bus.onPeer(ev, (id) => { attach(); f(id); }),
    send: (id, m) => hub.bus.send(id, m),
    session: (id) => { const s = sess(id); return s && s.connected ? s._fxSession() : null; },
    peerName: (id) => { const s = sess(id); return (s && s.displayName()) || 'the other computer'; },
    isComputer: (id) => { const s = sess(id); return !!s && !P.isPhoneOs(s.peerOs); },
    connectedIds: () => { attach(); return hub.bus.connectedIds(); },
    setRequest: (f) => { attach(); fn = f; },
  };
}

// For an app that hasn't loaded Drive: what its page shows.
function offView(settings) {
  const d = settings.drive || {};
  return { on: false, folder: d.folder || defaultFolder(), custom: !!d.folder, state: 'off', files: 0, bytes: 0, skipped: 0, conflicts: 0, lastSync: 0, connected: false, moving: 0, peer: '', error: '' };
}

module.exports = { create, createMesh, hubAdapter, offView, defaultFolder };
