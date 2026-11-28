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
  return createMesh({ settings, save, me, meName, userData, trash, onChange, mesh: soloMesh(adapter) });
}

// One to one: the session as a mesh of one device, so the main folder and the shared folders run on the
// same code as in Multi-device. The main folder speaks as before; an older TwinDesk never lists a shared
// folder, so it never gets one's messages. adapter.peerId() (optional): the other device's id, for the
// folders shared with some devices only; adapter.isComputer() (optional, else true).
function soloMesh(adapter) {
  let up = !!adapter.session();
  const id = () => (adapter.peerId && adapter.peerId()) || 'peer';
  const fns = { welcome: [], closed: [], transport: [] };
  let wired = false;
  const wire = () => {
    if (wired) return;
    wired = true;
    adapter.onUp(() => { up = true; for (const fn of fns.welcome) fn(id()); });
    adapter.onDown(() => { up = false; for (const fn of fns.closed) fn(id()); });
    adapter.onMoved(() => { for (const fn of fns.transport) fn(id()); });
  };
  return {
    on: (t, fn) => adapter.on(t, (m) => fn(m, id())),
    onPeer: (ev, fn) => { wire(); fns[ev].push(fn); },
    send: (_id, m) => adapter.send(m),
    session: () => adapter.session(),
    peerName: () => adapter.peerName() || 'the other computer',
    isComputer: () => (adapter.isComputer ? !!adapter.isComputer() : true),
    connectedIds: () => (up || adapter.session() ? [id()] : []),
    setRequest: (fn) => adapter.setRequest(fn),
  };
}

// Multi-device: the main folder and any extra folders (phase 3: shared folders per PC), each its own
// engine (its own index file) and a link to each connected computer it's shared with. A change adopted
// from one computer goes on to the others (the engine's 'changed'), so they all end up the same.
//
// settings.drive = {on, folder, devices?, folders: [{id, name, path, devices}]}
//   devices: 'all' (or missing) = every computer of the mesh, else the ids it's shared with. The main
//   folder speaks as before (no f); an extra folder's messages carry f = its id.
// drive.folders {list: [{f, name}]}: what this computer shares with that one, said on every session and
// change. A computer that hasn't the folder sees it as offered (Add); an extra folder's link opens only
// once the other side listed it too, so an older TwinDesk never gets an f it would take as the main one.
const FOLDERS = 'drive.folders';
const DF = require('./drive-folders.js');
const MAX_FOLDERS = DF.MAX;
const { safeName, cleanDevices } = DF;

function createMesh({ settings, save, me, meName, userData, trash, mesh, onChange = () => {} }) {
  let Drive = null, DriveLink = null, HEADER = '', PATH = '', hooked = false, running = false;
  const units = new Map(); // folder id ('' = the main folder) -> {drive, links: Map(peer id -> DriveLink), error}
  const theirs = new Map(); // peer id -> Map(f -> name): the extra folders it shares with us
  const cfg = () => {
    const c = settings.drive || (settings.drive = { on: false, folder: '' });
    if (!Array.isArray(c.folders)) c.folders = [];
    return c;
  };
  const def = (f) => (f ? cfg().folders.find((x) => x.id === f) || null : { id: '', name: '', path: cfg().folder, devices: cfg().devices });
  const folder = () => cfg().folder || defaultFolder();
  const pathOf = (f) => {
    if (!f) return folder();
    const d = def(f);
    return d ? DF.pathOf(d) : DF.defaultPath('');
  };
  const allows = (f, id) => { const d = def(f); return !!d && (!Array.isArray(d.devices) || d.devices.includes(id)); };
  const canLink = (f, id) => !!id && mesh.isComputer(id) && allows(f, id) && (!f || !!(theirs.get(id) && theirs.get(id).has(f)));

  const open = (f, id) => {
    const u = units.get(f);
    if (!u || !u.drive || !canLink(f, id)) return null;
    if (u.links.has(id)) return u.links.get(id);
    const l = new DriveLink({ drive: u.drive, folder: f, send: (m) => mesh.send(id, m), session: () => mesh.session(id), peerName: () => mesh.peerName(id), onChange });
    u.links.set(id, l);
    return l;
  };
  const close = (f, id) => {
    const u = units.get(f);
    const l = u && u.links.get(id);
    if (!l) return;
    u.links.delete(id);
    l.destroy();
    onChange();
  };
  // Every link that may run now runs, the rest close (a device list or what a computer shares changed).
  const settle = () => {
    for (const [f, u] of units) {
      for (const id of [...u.links.keys()]) if (!canLink(f, id)) close(f, id);
      for (const id of mesh.connectedIds()) if (!u.links.has(id)) { const l = open(f, id); if (l) l.start(); }
    }
    onChange();
  };
  const tell = (id) => {
    if (!running || !mesh.isComputer(id)) return;
    mesh.send(id, { t: FOLDERS, list: cfg().folders.filter((d) => allows(d.id, id)).map((d) => ({ f: d.id, name: d.name })) });
  };
  const tellAll = () => { for (const id of mesh.connectedIds()) tell(id); };

  // Registered once (the bus can't unregister): with Drive off they find no unit and do nothing.
  const hook = () => {
    if (hooked) return;
    hooked = true;
    for (const t of DRIVE_TYPES) {
      mesh.on(t, (m, from) => {
        const f = m && typeof m.f === 'string' ? m.f.slice(0, 40) : '';
        const u = units.get(f);
        if (!u) return;
        const l = u.links.get(from) || (t === P.T.DRIVE_HELLO ? open(f, from) : null);
        if (l) l.onMessage(m);
      });
    }
    mesh.on(FOLDERS, (m, from) => {
      if (!running || !mesh.isComputer(from)) return;
      const list = new Map();
      for (const x of Array.isArray(m && m.list) ? m.list.slice(0, MAX_FOLDERS) : []) {
        if (x && typeof x.f === 'string' && /^[0-9a-f]{8,40}$/.test(x.f)) list.set(x.f, safeName(x.name));
      }
      theirs.set(from, list);
      settle();
    });
    mesh.onPeer('welcome', (id) => {
      if (!running) return;
      tell(id);
      const l = open('', id);
      if (l) l.start();
      onChange();
    });
    mesh.onPeer('closed', (id) => { for (const f of units.keys()) close(f, id); theirs.delete(id); onChange(); });
    mesh.onPeer('transport', (id) => { for (const u of units.values()) { const l = u.links.get(id); if (l) l.kick(); } });
  };

  // Our server's HTTPS: the host session whose token the request carries, then its folder's link (&f=).
  const request = (req, res) => {
    if (!req.url.startsWith(PATH)) return false;
    const tok = req.headers[HEADER];
    let f = '';
    try { f = new URL(req.url, 'https://x').searchParams.get('f') || ''; } catch { /* no folder: the main one */ }
    const u = units.get(f);
    if (u && typeof tok === 'string' && tok) {
      for (const [id, l] of u.links) {
        const s = mesh.session(id);
        if (s && s.host && s.token === tok) return l.request(req, res);
      }
    }
    res.writeHead(403);
    res.end();
    return true;
  };

  async function startUnit(f) {
    if (units.has(f)) return;
    const u = { drive: null, links: new Map(), error: '' };
    units.set(f, u);
    const drive = new Drive({ me, meName, folder: () => pathOf(f), indexFile: path.join(userData, f ? `drive-index-${f}.json` : 'drive-index.json'), trash });
    drive.on('change', onChange);
    u.drive = drive;
    try {
      if (f) require('fs').mkdirSync(pathOf(f), { recursive: true });
      await drive.start();
    } catch (e) {
      u.error = e.message;
    }
    if (units.get(f) !== u) return; // stopped meanwhile
    for (const id of mesh.connectedIds()) { const l = open(f, id); if (l) l.start(); }
    onChange();
  }

  async function stopUnit(f) {
    const u = units.get(f);
    if (!u) return;
    for (const id of [...u.links.keys()]) close(f, id);
    units.delete(f);
    if (u.drive) await u.drive.stop();
    onChange();
  }

  async function start() {
    if (running) return;
    const { Drive: D } = require('./drive.js');
    Drive = D;
    ({ DriveLink, HEADER, PATH } = require('./drive-link.js'));
    running = true;
    hook();
    mesh.setRequest(request);
    tellAll();
    await Promise.all([startUnit(''), ...cfg().folders.map((d) => startUnit(d.id))]);
    onChange();
  }

  async function stop() {
    running = false;
    mesh.setRequest(null);
    theirs.clear();
    await Promise.all([...units.keys()].map((f) => stopUnit(f)));
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
      if (running) { await stopUnit(''); await startUnit(''); }
      onChange();
    },
    folder,
    // An extra folder: a new one (name, path?, devices?), or one a computer offered (its id). → its id
    async addFolder({ id, name, path: p, devices } = {}) {
      const c = cfg();
      if (c.folders.length >= MAX_FOLDERS) return null;
      const fid = typeof id === 'string' && /^[0-9a-f]{8,40}$/.test(id) ? id : require('crypto').randomBytes(8).toString('hex');
      if (c.folders.some((x) => x.id === fid)) return fid;
      let n = name;
      if (!n) for (const l of theirs.values()) if (l.has(fid)) n = l.get(fid);
      c.folders.push({ id: fid, name: safeName(n), path: typeof p === 'string' ? p : '', devices: cleanDevices(devices) });
      save();
      tellAll();
      if (running) await startUnit(fid);
      settle();
      return fid;
    },
    // Stops syncing it here; its files stay where they are.
    async removeFolder(fid) {
      const c = cfg();
      if (!c.folders.some((x) => x.id === fid)) return;
      c.folders = c.folders.filter((x) => x.id !== fid);
      save();
      await stopUnit(fid);
      tellAll();
      onChange();
    },
    // '' for the main folder; devices: 'all' or [ids].
    setFolderDevices(fid, devices) {
      const d = fid ? cfg().folders.find((x) => x.id === fid) : null;
      if (fid && !d) return;
      if (d) d.devices = cleanDevices(devices);
      else cfg().devices = cleanDevices(devices);
      save();
      tellAll();
      settle();
    },
    async setFolderPath(fid, p) {
      const d = cfg().folders.find((x) => x.id === fid);
      if (!d) return;
      d.path = typeof p === 'string' ? p : '';
      save();
      if (running) { await stopUnit(fid); await startUnit(fid); }
      onChange();
    },
    pathOf,
    view() {
      const one = (f) => {
        const u = units.get(f);
        const s = u && u.drive ? u.drive.status() : null;
        let moving = 0;
        const peers = [];
        if (u) for (const [id, l] of u.links) { const st = l.status(); moving += st.moving; if (st.connected) peers.push(mesh.peerName(id)); }
        return {
          state: s ? s.state : 'off', files: s ? s.files : 0, bytes: s ? s.bytes : 0,
          skipped: s ? s.skipped : 0, conflicts: s ? s.conflicts : 0, lastSync: s ? s.lastSync : 0,
          connected: peers.length > 0, moving, peer: peers.join(', '), error: (u && u.error) || (s && s.error) || '',
        };
      };
      const c = cfg();
      const computers = mesh.connectedIds().filter((id) => mesh.isComputer(id)).map((id) => ({ id, name: mesh.peerName(id) }));
      const have = new Set(c.folders.map((d) => d.id));
      const offers = new Map();
      for (const [id, l] of theirs) for (const [f, name] of l) if (!have.has(f)) { const o = offers.get(f) || { f, name, from: [] }; o.from.push(mesh.peerName(id)); offers.set(f, o); }
      return {
        on: c.on === true, folder: folder(), custom: !!c.folder, ...one(''),
        devices: cleanDevices(c.devices), computers,
        folders: c.folders.map((d) => ({ id: d.id, name: d.name, path: pathOf(d.id), custom: !!d.path, devices: cleanDevices(d.devices), ...one(d.id) })),
        offers: [...offers.values()],
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

module.exports = { create, createMesh, soloMesh, hubAdapter, offView, defaultFolder };
