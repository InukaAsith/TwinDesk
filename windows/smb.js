// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Network drives: this PC shares one folder with the Mac (a hidden,
// network-only local account with a random password, made once with administrator rights), and
// maps the Mac's shared folder as a drive. Credentials only travel over the paired link; ours are
// kept encrypted with Windows DPAPI (Electron safeStorage).
const { app, safeStorage } = require('electron');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const { script, scriptElevated } = require('./ps');

const T = P.T;
const SHARE = 'MacShare';
const USER = 'macshare';
const FPS_GROUP = '@FirewallAPI.dll,-28502'; // "File and Printer Sharing" (locale-independent id)

class Smb {
  // opts: link, settings (shared), save(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.credFile = path.join(app.getPath('userData'), 'smb-share.bin');
    this.busy = '';         // 'setup' | 'remove' | 'mount' while working
    this.message = '';      // last problem with our share
    this.peerState = null;  // the Mac's smb.state about our share
    this.mac = null;        // {share, user, password, port} from the Mac's smb.offer (memory only)
    this.drive = '';        // mapped drive letter for the Mac's share, e.g. 'Z:'
    this.mountMessage = '';

    this.link.on('welcome', () => this._offer());
    this.link.on(T.SMB_STATE, (m) => { if (m.share === SHARE) { this.peerState = { mounted: !!m.mounted, error: m.error || '' }; this.onChange(); } });
    this.link.on(T.SMB_OFFER, (m) => this._onMacOffer(m));
    this.link.on(T.SMB_REVOKE, (m) => this._unmount(m.share));
  }

  get cfg() {
    return this.settings.files;
  }

  // ---- this PC shares a folder ----

  _creds() {
    try {
      if (!fs.existsSync(this.credFile)) return null;
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(this.credFile)));
    } catch (_) { return null; }
  }

  _offer() {
    const c = this._creds();
    if (this.cfg.shareOn && c) this.link.send({ t: T.SMB_OFFER, share: SHARE, user: c.user, password: c.password, port: 445 });
  }

  // One switch: on → share the folder (default %USERPROFILE%\TwinDesk); the admin
  // prompt only comes the first time or after the folder changed. Off → the Mac unmounts; the share
  // and account stay, so switching on again needs no prompt.
  async setShareOn(on) {
    if (this.busy) return;
    if (!on) {
      this.cfg.shareOn = false;
      this.save();
      this.link.send({ t: T.SMB_REVOKE, share: SHARE });
      this.peerState = null;
      return this.onChange();
    }
    const folder = this.cfg.shareFolder || path.join(os.homedir(), 'MacShare');
    try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { return this._msg('Can’t create ' + folder + ': ' + e.message); }
    await this.checkShare();
    if (this._creds() && this.sharePath && this.sharePath.toLowerCase() === folder.toLowerCase()) {
      this.cfg.shareOn = true;
      this.cfg.shareFolder = folder;
      this.save();
      this.message = '';
      this._offer();
      return this.onChange();
    }
    await this.share(folder);
  }

  // Choose… a different folder: shared right away if sharing is on, else remembered for later.
  async chooseFolder(folder) {
    if (!folder) return;
    if (this.cfg.shareOn) return this.share(folder);
    this.cfg.shareFolder = folder;
    this.save();
    this.onChange();
  }

  // One elevated script: account, folder permission, share, firewall (File and Printer Sharing, Private).
  async share(folder) {
    if (this.busy) return;
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return this._msg('Pick a folder first');
    if (!safeStorage.isEncryptionAvailable()) return this._msg('Windows can’t protect the password here (DPAPI unavailable)');
    const password = 'Ms-' + crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x') + '!7a';
    const dir = app.getPath('userData');
    const pwFile = path.join(dir, 'smb-pw.tmp');
    const result = path.join(dir, 'smb-result.txt');
    fs.writeFileSync(pwFile, password, { mode: 0o600 });
    try { fs.unlinkSync(result); } catch (_) { /* none */ }
    this._busy('setup');
    try {
      await scriptElevated('smb-share', { PwFile: pwFile, User: USER, Share: SHARE, Folder: folder, Group: FPS_GROUP, Result: result });
      const r = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').trim() : 'error: the setup didn’t finish';
      if (r !== 'ok') throw new Error(r.replace(/^error: /, ''));
      fs.writeFileSync(this.credFile, safeStorage.encryptString(JSON.stringify({ user: USER, password })));
      this.cfg.shareOn = true;
      this.cfg.shareFolder = folder;
      this.save();
      this.message = '';
      this._offer();
    } catch (e) {
      this.message = /cancel/i.test(e.message) ? 'The administrator prompt was declined' : 'Sharing failed: ' + e.message;
    } finally {
      try { fs.unlinkSync(pwFile); } catch (_) { /* removed by the script */ }
      try { fs.unlinkSync(result); } catch (_) { /* none */ }
      this._busy('');
    }
  }

  // Stop sharing: the Mac unmounts; the share and the account are removed (elevated).
  async unshare() {
    if (this.busy) return;
    this.link.send({ t: T.SMB_REVOKE, share: SHARE });
    this._busy('remove');
    try {
      await scriptElevated('smb-unshare', { Share: SHARE, User: USER });
      this.message = '';
    } catch (e) {
      this.message = /cancel/i.test(e.message) ? 'Cancelled. The folder is still shared.' : e.message;
    }
    try { fs.unlinkSync(this.credFile); } catch (_) { /* none */ }
    this.cfg.shareOn = false;
    this.save();
    this.peerState = null;
    this._busy('');
  }

  // Does Windows still have our share? (shown in the UI; no elevation needed)
  async checkShare() {
    try {
      const out = await script('smb-path', { Share: SHARE });
      this.sharePath = out.trim();
    } catch (_) { this.sharePath = ''; }
    this.onChange();
  }

  // ---- the Mac shares a folder: map it as a drive ----

  async _onMacOffer(m) {
    if (typeof m.share !== 'string' || typeof m.user !== 'string' || typeof m.password !== 'string') return;
    this.mac = { share: m.share, user: m.user, password: m.password };
    if (!this.cfg.mountMac) return this._state(m.share, false, 'Turned off on the other computer');
    await this.mount();
  }

  async mount() {
    const m = this.mac;
    const addr = this.link.snapshot().link.address;
    if (!m || !addr || this.busy) return;
    if (!/^[\w.$ -]+$/.test(m.share)) return this._state(m.share, false, 'Bad share name');
    const unc = '\\\\' + addr + '\\' + m.share;
    this._busy('mount');
    try {
      const existing = await mappedLetter(unc);
      if (existing) this.drive = existing;
      else {
        await exec('cmdkey.exe', ['/add:' + addr, '/user:' + m.user, '/pass:' + m.password]);
        const letter = freeLetter();
        if (!letter) throw new Error('No free drive letter');
        await exec('net.exe', ['use', letter, unc, '/persistent:no']);
        this.drive = letter;
        this._label(addr, m.share);
      }
      this.mountMessage = '';
      this._state(m.share, true);
    } catch (e) {
      this.drive = '';
      this.mountMessage = 'Couldn’t connect {name}’s folder: ' + e.message;
      this._state(m.share, false, e.message);
    }
    this._busy('');
  }

  // Name the mapped drive in This PC: "TwinDesk on <Mac>" instead of the share path.
  _label(addr, share) {
    const mac = this.link.snapshot().link.macName || 'the other computer';
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\##' + addr + '#' + share;
    exec('reg.exe', ['add', key, '/v', '_LabelFromReg', '/t', 'REG_SZ', '/d', 'TwinDesk on ' + mac, '/f']).catch(() => {});
  }

  async _unmount(share) {
    const addr = this.link.snapshot().link.address;
    if (this.drive) await exec('net.exe', ['use', this.drive, '/delete', '/y']).catch(() => {});
    if (addr) await exec('cmdkey.exe', ['/delete:' + addr]).catch(() => {});
    this.drive = '';
    if (share) { this.mac = null; this._state(share, false); }
    this.onChange();
  }

  // Switch "Connect the Mac's shared folder" changed.
  applyMount() {
    if (this.cfg.mountMac && this.mac) this.mount();
    else if (!this.cfg.mountMac && this.drive) this._unmount(null).then(() => this.mac && this._state(this.mac.share, false, 'Turned off on the other computer'));
  }

  _state(share, mounted, error) {
    const msg = { t: T.SMB_STATE, share, mounted };
    if (error) msg.error = error;
    this.link.send(msg);
    this.onChange();
  }

  _msg(text) { this.message = text; this.onChange(); }
  _busy(what) { this.busy = what; this.onChange(); }

  view() {
    return {
      busy: this.busy, message: this.message, sharing: !!(this.cfg.shareOn && this._creds()),
      peer: this.peerState, macShare: this.mac ? this.mac.share : '', drive: this.drive, mountMessage: this.mountMessage,
      wifi: !this.drive && !!this.mac && !!(this.canWifi && this.canWifi()), // through Bluetooth: Open connects it over Wi-Fi Direct
      folder: this.cfg.shareFolder || path.join(os.homedir(), 'MacShare'),
    };
  }
}

function exec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 45000 }, (err, stdout, stderr) =>
      (err ? reject(new Error(String(stderr || stdout || err.message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' '))) : resolve(String(stdout))));
  });
}

// A drive letter already mapped to this UNC path (from `net use`, matching the path only).
async function mappedLetter(unc) {
  try {
    const out = await exec('net.exe', ['use']);
    for (const line of out.split(/\r?\n/)) {
      const m = /\b([A-Z]:)\s+(\\\\\S+)/i.exec(line);
      if (m && m[2].toLowerCase() === unc.toLowerCase()) return m[1].toUpperCase();
    }
  } catch (_) { /* no mappings */ }
  return '';
}

function freeLetter() {
  for (const c of 'ZYXWVUTSRQPONMLKJIHG') if (!fs.existsSync(c + ':\\')) return c + ':';
  return '';
}

module.exports = Smb;
