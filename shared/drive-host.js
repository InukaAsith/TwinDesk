// TwinDesk Drive in a computer's one-to-one app (docs/drive.md): the Files page's switch and folder,
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

// For an app that hasn't loaded Drive: what its page shows.
function offView(settings) {
  const d = settings.drive || {};
  return { on: false, folder: d.folder || defaultFolder(), custom: !!d.folder, state: 'off', files: 0, bytes: 0, skipped: 0, conflicts: 0, lastSync: 0, connected: false, moving: 0, peer: '', error: '' };
}

module.exports = { create, offView, defaultFolder };
