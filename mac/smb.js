// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Network drives: mount the PC's share when it offers one, and share
// one folder of this Mac with the PC (admin setup once via scripts/smb-share.sh).
// The share password is kept encrypted with Electron safeStorage (Keychain-backed) in settings.
//
// Events: 'change' — this.view changed.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { safeStorage, shell } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const SCRIPTS = path.join(__dirname, 'scripts');
const DEFAULT_FOLDER = path.join(os.homedir(), 'MacShare'); // shared with the PC unless another is chosen

// An existing smbfs mount of //…@host/share, if any (e.g. still mounted from the last run).
function existingMount(host, share) {
  try {
    const out = require('child_process').execFileSync('/sbin/mount', [], { encoding: 'utf8' });
    const want = `@${host}/${share}`.toLowerCase();
    const line = out.split('\n').find((l) => l.toLowerCase().includes(want) && l.includes('(smbfs'));
    const m = line && / on (.+?) \(smbfs/.exec(line);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX shell quoting

function portOpen(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: ms });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

// Run a script as root through the macOS administrator prompt.
function asAdmin(cmd, prompt) {
  const script = `do shell script ${JSON.stringify(cmd)} with prompt ${JSON.stringify(prompt)} with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120000 }, (err, out, errOut) => {
      if (err) reject(new Error(/User canceled|-128/.test(String(errOut)) ? 'cancelled' : String(errOut || err.message).trim()));
      else resolve(out.trim());
    });
  });
}

// Run one of scripts/*.sh as root. The admin shell may not read files in privacy-protected folders
// (Desktop, Documents, Downloads — where a dev checkout often lives): "Operation not permitted".
// So it runs a copy from a fresh private temp folder, removed afterwards.
async function runScript(name, args, prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macshare-'));
  const copy = path.join(dir, name);
  try {
    fs.copyFileSync(path.join(SCRIPTS, name), copy);
    fs.chmodSync(copy, 0o700);
    return await asAdmin(`/bin/sh ${[copy, ...args].map(q).join(' ')}`, prompt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

class Smb extends EventEmitter {
  constructor({ server, helper, getSettings, saveSettings }) {
    super();
    Object.assign(this, { server, helper, getSettings, saveSettings });
    this.offer = null; // the PC's last smb.offer (+ its address)
    this.mount = { path: null, error: null, busy: false };
    this.share = { busy: false, error: null, peer: null }; // peer = the PC's smb.state for our share
    this.shownOnce = false; // open the PC's folder in Finder the first time it connects

    server.on(`t:${P.T.SMB_OFFER}`, (m, ctx) => {
      this.offer = { share: String(m.share || ''), user: String(m.user || ''), password: String(m.password || ''), port: Number(m.port) || 445, host: ctx.address };
      this.mountPc();
    });
    server.on(`t:${P.T.SMB_REVOKE}`, () => {
      this.offer = null;
      this.unmountPc();
    });
    server.on(`t:${P.T.SMB_STATE}`, (m) => {
      this.share.peer = { mounted: !!m.mounted, error: m.error || null };
      this.emit('change');
    });
    server.on('client', () => this._offerOurs());
  }

  get cfg() {
    return this.getSettings().smb;
  }

  _state(fields) {
    if (this.offer) this.server.sendToClient({ t: P.T.SMB_STATE, share: this.offer.share, ...fields });
  }

  // ---- the PC's folder here ----

  // Through Bluetooth the PC's address is the pipe's: not mounted there. openPc moves the session
  // onto Wi-Fi Direct first (this.wifi(on), from main.js), kept up while it's mounted.
  get onBle() {
    const c = this.server.server.current;
    return !!c && c.transport === 'ble';
  }

  async mountPc() {
    const o = this.offer;
    if (!o || !this.cfg.connectPc || this.mount.busy) return this.emit('change');
    if (this.mount.path && fs.existsSync(this.mount.path)) return this._state({ mounted: true });
    if (this.onBle) return this.emit('change');
    const c = this.server.server.current;
    if (c && c.address) o.host = c.address; // where the session is now (it moves off Bluetooth)
    this.mount = { path: null, error: null, busy: true };
    this.emit('change');
    let err = null;
    if (!(await portOpen(o.host, o.port))) {
      err = `can’t reach ${o.host}. Check its firewall.`;
    } else {
      const url = `smb://${o.host}${o.port === 445 ? '' : `:${o.port}`}/${encodeURIComponent(o.share)}`;
      try {
        this.mount.path = (await this.helper.request('smbMount', { url, user: o.user, password: o.password }, 60000)).path;
      } catch (e) {
        this.mount.path = existingMount(o.host, o.share);
        if (!this.mount.path) err = e.message;
      }
    }
    this.mount.busy = false;
    this.mount.error = err;
    this._state(err ? { mounted: false, error: err } : { mounted: true });
    if (!err && !this.shownOnce) {
      this.shownOnce = true;
      shell.openPath(this.mount.path); // so it's visible right away (it's also in Finder's sidebar)
    }
    this.emit('change');
  }

  async unmountPc() {
    const p = this.mount.path;
    this.mount = { path: null, error: null, busy: false };
    if (this.wifi) this.wifi(false);
    if (p) await this.helper.request('smbUnmount', { path: p }).catch((e) => console.error(`[smb] unmount: ${e.message}`));
    this.emit('change');
  }

  async openPc() {
    if (this.mount.path) return shell.openPath(this.mount.path);
    if (!this.offer || !this.onBle || !this.wifi || this.mount.busy) return;
    this.mount = { path: null, error: null, busy: true };
    this.emit('change');
    const ok = await this.wifi(true);
    this.mount.busy = false;
    if (!ok) {
      this.mount.error = 'Wi-Fi Direct didn’t come up';
      return this.emit('change');
    }
    this.shownOnce = false; // shown once it's mounted
    await this.mountPc();
    if (!this.mount.path) this.wifi(false);
  }

  // ---- a folder of this Mac on the PC ----

  _secret() {
    const s = this.cfg.secret;
    if (!s) return null;
    try {
      return safeStorage.decryptString(Buffer.from(s, 'base64'));
    } catch {
      return null;
    }
  }

  _offerOurs() {
    const pw = this._secret();
    if (this.cfg.sharing && pw) this.server.sendToClient({ t: P.T.SMB_OFFER, share: 'MacShare', user: 'macshare', password: pw, port: 445 });
  }

  // One switch: share the chosen folder, or ~/TwinDesk (created if missing).
  async startSharing(folder) {
    folder = folder || this.cfg.folder || DEFAULT_FOLDER;
    if (this.share.busy) return;
    fs.mkdirSync(folder, { recursive: true });
    this.share = { busy: true, error: null, peer: null };
    this.emit('change');
    const pw = crypto.randomBytes(18).toString('base64url');
    const pwFile = path.join(os.tmpdir(), `macshare-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(pwFile, pw, { mode: 0o600 });
    try {
      await runScript('smb-share.sh', [folder, pwFile], 'TwinDesk wants to share a folder with the other computer.');
      const c = this.cfg;
      c.sharing = true;
      c.folder = folder;
      c.secret = safeStorage.encryptString(pw).toString('base64');
      this.saveSettings();
      this._offerOurs();
    } catch (e) {
      this.share.error = e.message === 'cancelled' ? null : e.message;
    } finally {
      fs.rmSync(pwFile, { force: true });
      this.share.busy = false;
      this.emit('change');
    }
  }

  async stopSharing() {
    const c = this.cfg;
    if (this.share.busy || !c.sharing) return;
    this.share = { busy: true, error: null, peer: null };
    this.emit('change');
    try {
      await runScript('smb-unshare.sh', [c.folder], 'TwinDesk wants to stop sharing the folder.');
      this.server.sendToClient({ t: P.T.SMB_REVOKE, share: 'MacShare' });
      c.sharing = false;
      c.secret = '';
      this.saveSettings();
    } catch (e) {
      this.share.error = e.message === 'cancelled' ? null : e.message;
    } finally {
      this.share.busy = false;
      this.emit('change');
    }
  }

  get view() {
    return {
      pcOffered: !!this.offer,
      pcShare: this.offer ? `\\\\${this.offer.host}\\${this.offer.share}` : null,
      defaultFolder: DEFAULT_FOLDER,
      mounted: this.mount.path,
      mountError: this.mount.error,
      mounting: this.mount.busy,
      wifi: !!this.offer && this.cfg.connectPc && !this.mount.path && this.onBle && !!this.wifi, // Open connects it over Wi-Fi Direct
      shareBusy: this.share.busy,
      shareError: this.share.error,
      peer: this.share.peer,
    };
  }
}

module.exports = { Smb };
