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
const OPTIONS = 'no-agent-forwarding,no-X11-forwarding,no-port-forwarding';
const OURS = / macshare:[A-Za-z0-9._-]*$/; // the marker at the end of each line we add
const clean = (id) => String(id || '').replace(/[^A-Za-z0-9._-]/g, '');

class Sshd {
  // opts: link, settings (shared), save(), onChange()
  //   bus, consent (shared/consent.js): Multi-device. Every device's key is heard and kept by its own id,
  //   and each device's own pair decides it ("Let {name} open a terminal"): on the facade a key from a
  //   device that wasn't selected was dropped, a key left from one device could go in under the next
  //   one's marker, and a crossing to a pair with it off removed every device's key (#313).
  constructor(opts) {
    Object.assign(this, opts);
    this.service = 'unknown'; // 'running' | 'stopped' | 'missing' | 'unknown'
    this.isAdmin = null;
    this.pending = new Map(); // device id -> its last ssh.key line
    this.infos = new Map(); // device id -> the last ssh.info we sent it ({enabled, why})
    this.busy = false;
    this.message = '';
    if (this.bus) {
      this.bus.on(T.SSH_KEY, (m, from) => this._onKey(m, from));
      this.bus.on(T.SSH_FORGET, (m, from) => this._forget(from));
    } else {
      this.link.on(T.SSH_KEY, (m) => this._onKey(m, this.macId()));
      this.link.on(T.SSH_FORGET, () => this._forget(this.macId()));
    }
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

  // The other computer's id (one-to-one): the session's, whichever side opened it (we may be the host).
  macId() {
    const snap = this.link.snapshot();
    if (snap.session && snap.session.id) return String(snap.session.id).replace(/[^A-Za-z0-9._-]/g, '');
    return snap.paired ? snap.paired.macId : 'mac';
  }

  // The device the Terminal page shows.
  _shown() {
    return this.bus ? this.bus.selectedId() : this.macId();
  }

  _allowed(id) {
    return this.consent ? this.consent.get(id, 'terminal', 'out') : !!this.cfg.allowMac;
  }

  _send(id, msg) {
    return this.bus ? this.bus.send(id, msg) : this.link.send(msg);
  }

  async _onKey(m, id) {
    const pub = typeof m.pub === 'string' ? m.pub.trim().split(/\s+/).slice(0, 2).join(' ') : '';
    if (!id || !/^(ssh-ed25519|ecdsa-sha2-\S+|ssh-rsa) [A-Za-z0-9+/=]+$/.test(pub)) return;
    this.pending.set(id, pub);
    await this._applyOne(id);
  }

  // The switch changed (or Set up): every device by its own pair.
  async apply() {
    if (!this.bus && !this.cfg.allowMac) { // one-to-one, off: no key of ours stays authorized, even one added before a restart
      await this._removeAll();
      const id = this.macId();
      return this.pending.has(id) ? this._info(id, false, 'not_allowed') : this.onChange();
    }
    const ids = this.bus ? new Set([...this.pending.keys(), ...Object.keys(this.cfg.installedKeys || {})]) : [this.macId()];
    for (const id of ids) await this._applyOne(id);
    this.onChange();
  }

  async _applyOne(id) {
    if (!this._allowed(id)) { // off for this pair: its key comes out, the others stay
      if (this._installed(id)) await this._forgetLine(id);
      return this.pending.has(id) ? this._info(id, false, 'not_allowed') : this.onChange();
    }
    const pub = this.pending.get(id);
    if (!pub) return this.onChange();
    await this.refresh();
    if (this.service !== 'running') return this._info(id, false, 'remote_login_off');
    const line = OPTIONS + ' ' + pub + ' macshare:' + clean(id);
    const digest = crypto.createHash('sha256').update(line).digest('hex');
    if (this._installed(id) !== digest) {
      try {
        await this._install(line, id);
        this._mark(digest, id);
        this.save();
        this.message = '';
      } catch (e) {
        this.message = /cancel/i.test(e.message) ? 'The administrator prompt was declined' : 'Couldn’t add {name}’s key: ' + e.message;
        return this._info(id, false, 'not_allowed');
      }
    }
    this._info(id, true);
  }

  // What we installed for this device (each device's line by its id; a key installed before that list
  // existed counts for whichever device it was).
  _installed(id) {
    const map = this.cfg.installedKeys || {};
    return map[clean(id)] || (Object.keys(map).length ? '' : this.cfg.installedKey);
  }

  _mark(digest, id) {
    this.cfg.installedKeys = { ...(this.cfg.installedKeys || {}) };
    if (digest) this.cfg.installedKeys[clean(id)] = digest;
    else delete this.cfg.installedKeys[clean(id)];
    const left = Object.values(this.cfg.installedKeys);
    this.cfg.installedKey = digest || left[left.length - 1] || '';
  }

  // Replace this device's marked line in the right authorized_keys file.
  async _install(line, id) {
    const marker = ' macshare:' + clean(id);
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

  // Unpaired (one-to-one), or the Terminal off there: every line we added comes out (any computer's
  // marker). The keys stay in memory: switching on again adds them. Unpaired: dropped from memory too.
  async revokeAll() {
    this.pending.clear();
    await this._removeAll();
    this.onChange();
  }

  async _removeAll() {
    if (!this.cfg.installedKey) return;
    try {
      if (this.isAdmin) {
        await scriptElevated('sshd-key', { Path: ADMIN_KEYS, All: true });
      } else {
        const f = path.join(os.homedir(), '.ssh', 'authorized_keys');
        if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l && !OURS.test(l)).join('\n') + '\n');
      }
      this.cfg.installedKey = '';
      this.cfg.installedKeys = {};
      this.save();
      this.message = '';
    } catch (e) {
      this.message = /cancel/i.test(e.message) ? 'The administrator prompt was declined: {name}’s key is still installed' : '{Name}’s key is still installed: ' + e.message;
    }
  }

  // The device said its Terminal forgot this computer (ssh.forget): its key comes out.
  async _forget(id) {
    this.pending.delete(id);
    await this._forgetLine(id);
    this.onChange();
  }

  async _forgetLine(id) {
    if (!this.cfg.installedKey) return;
    const marker = ' macshare:' + clean(id);
    try {
      if (this.isAdmin) {
        await scriptElevated('sshd-key', { Path: ADMIN_KEYS, Marker: marker });
      } else {
        const f = path.join(os.homedir(), '.ssh', 'authorized_keys');
        if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l && !l.endsWith(marker)).join('\n') + '\n');
      }
      this._mark('', id);
      this.save();
    } catch (e) {
      this.message = '{Name}’s key is still installed: ' + e.message;
    }
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

  async _info(id, enabled, why) {
    const msg = { t: T.SSH_INFO, enabled };
    if (enabled) {
      msg.user = os.userInfo().username;
      msg.port = 22;
      msg.hostKeys = await hostKeys();
    } else msg.why = why;
    this._send(id, msg);
    this.infos.set(id, { enabled, why: why || '' });
    this.onChange();
  }

  // The Terminal page: the device it shows.
  view() {
    const id = this._shown();
    return { service: this.service, busy: this.busy, message: this.message, macAsked: !!(id && this.pending.has(id)), info: (id && this.infos.get(id)) || null, admin: this.isAdmin };
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
