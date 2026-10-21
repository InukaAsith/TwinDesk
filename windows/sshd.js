// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal, the other computer → this PC (it may be a Mac, another PC or Linux): it sends `ssh.key`;
// with "Let {name} open a terminal on {me}" on and Windows' OpenSSH Server running, its key goes
// into authorized_keys (administrators_authorized_keys for admin accounts, written elevated) with
// the marker `macshare:<peer id>`, and we answer `ssh.info` with this PC's host keys.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../shared/protocol.js');
const { script, scriptElevated } = require('./ps');

const T = P.T;
const SSH_DATA = path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh');
const ADMIN_KEYS = path.join(SSH_DATA, 'administrators_authorized_keys');
const OPTIONS = 'no-agent-forwarding,no-X11-forwarding';

class Sshd {
  // opts: link, settings (shared), save(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.service = 'unknown'; // 'running' | 'stopped' | 'missing' | 'unknown'
    this.isAdmin = null;
    this.pendingKey = null;   // the Mac's last ssh.key line
    this.busy = false;
    this.message = '';
    this.link.on(T.SSH_KEY, (m) => this._onKey(m));
    this.link.on(T.SSH_FORGET, () => this._forget());
    this.refresh();
  }

  get cfg() {
    return this.settings.terminal;
  }

  async refresh() {
    try {
      const out = (await script('sshd-status')).trim();
      this.service = /^(running|stopped|missing)$/.test(out) ? out : 'unknown';
    } catch (_) { this.service = 'unknown'; }
    if (this.isAdmin === null) this.isAdmin = await adminMember();
    this.onChange();
  }

  // The other computer's id: the session's, whichever side opened it (we may be the host).
  macId() {
    const snap = this.link.snapshot();
    if (snap.session && snap.session.id) return String(snap.session.id).replace(/[^A-Za-z0-9._-]/g, '');
    return snap.paired ? snap.paired.macId : 'mac';
  }

  async _onKey(m) {
    const pub = typeof m.pub === 'string' ? m.pub.trim().split(/\s+/).slice(0, 2).join(' ') : '';
    if (!/^(ssh-ed25519|ecdsa-sha2-\S+|ssh-rsa) [A-Za-z0-9+/=]+$/.test(pub)) return;
    this.pendingKey = pub;
    await this.apply();
  }

  // Called on a key from the Mac and when the switch changes.
  async apply() {
    if (!this.pendingKey) return this.onChange();
    if (!this.cfg.allowMac) return this._info(false, 'not_allowed');
    await this.refresh();
    if (this.service !== 'running') return this._info(false, 'remote_login_off');
    const line = OPTIONS + ' ' + this.pendingKey + ' macshare:' + this.macId();
    const digest = crypto.createHash('sha256').update(line).digest('hex');
    if (this.cfg.installedKey !== digest) {
      try {
        await this._install(line);
        this.cfg.installedKey = digest;
        this.save();
        this.message = '';
      } catch (e) {
        this.message = /cancel/i.test(e.message) ? 'The administrator prompt was declined' : 'Couldn’t add {name}’s key: ' + e.message;
        return this._info(false, 'not_allowed');
      }
    }
    this._info(true);
  }

  // Replace our marked line in the right authorized_keys file.
  async _install(line) {
    const marker = ' macshare:' + this.macId();
    if (this.isAdmin) {
      const keyFile = path.join(os.tmpdir(), 'macshare-key-' + process.pid + '.txt');
      fs.writeFileSync(keyFile, line);
      try {
        await scriptElevated('sshd-key', { Path: ADMIN_KEYS, Marker: marker, KeyFile: keyFile });
      } finally { try { fs.unlinkSync(keyFile); } catch (_) { /* gone */ } }
    } else {
      const dir = path.join(os.homedir(), '.ssh');
      const f = path.join(dir, 'authorized_keys');
      fs.mkdirSync(dir, { recursive: true });
      const keep = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l && !l.endsWith(marker)) : [];
      fs.writeFileSync(f, keep.concat(line).join('\n') + '\n');
    }
  }

  async _forget() {
    this.pendingKey = null;
    if (!this.cfg.installedKey) return this.onChange();
    const marker = ' macshare:' + this.macId();
    try {
      if (this.isAdmin) {
        await scriptElevated('sshd-key', { Path: ADMIN_KEYS, Marker: marker });
      } else {
        const f = path.join(os.homedir(), '.ssh', 'authorized_keys');
        if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l && !l.endsWith(marker)).join('\n') + '\n');
      }
      this.cfg.installedKey = '';
      this.save();
    } catch (e) {
      this.message = '{Name}’s key is still installed: ' + e.message;
    }
    this.onChange();
  }

  // One elevated step: OpenSSH Server installed, automatic, running (its installer adds the rule).
  async setup() {
    if (this.busy) return;
    this.busy = true;
    this.onChange();
    try {
      await scriptElevated('sshd-setup', {}, 600000);
      this.message = '';
    } catch (e) {
      this.message = /cancel/i.test(e.message) ? 'The administrator prompt was declined' : 'Setup failed: ' + e.message;
    }
    this.busy = false;
    await this.refresh();
    await this.apply();
  }

  async _info(enabled, why) {
    const msg = { t: T.SSH_INFO, enabled };
    if (enabled) {
      msg.user = os.userInfo().username;
      msg.port = 22;
      msg.hostKeys = await hostKeys();
    } else msg.why = why;
    this.link.send(msg);
    this.lastInfo = { enabled, why: why || '' };
    this.onChange();
  }

  view() {
    return { service: this.service, busy: this.busy, message: this.message, macAsked: !!this.pendingKey, info: this.lastInfo || null, admin: this.isAdmin };
  }
}

// The host keys: asked from the running server (the .pub files are admin-only), else the files.
function hostKeys() {
  const keyscan = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keyscan.exe');
  return new Promise((resolve) => {
    execFile(keyscan, ['-p', '22', '127.0.0.1'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      const keys = String(out || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
        .map((l) => l.trim().split(/\s+/).slice(1, 3).join(' ')).filter((k) => /^\S+ [A-Za-z0-9+/=]+$/.test(k));
      if (keys.length) return resolve(keys);
      try {
        resolve(fs.readdirSync(SSH_DATA).filter((f) => /^ssh_host_\w+_key\.pub$/.test(f))
          .map((f) => fs.readFileSync(path.join(SSH_DATA, f), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')));
      } catch (_) { resolve([]); }
    });
  });
}

// Member of Administrators (also when UAC filters the token): sshd then reads administrators_authorized_keys.
function adminMember() {
  return new Promise((resolve) => {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups'], { windowsHide: true }, (err, out) => resolve(!err && /S-1-5-32-544/.test(String(out))));
  });
}

module.exports = Sshd;
