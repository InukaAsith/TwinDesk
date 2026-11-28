// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal, the other computer → this one (Linux version of
// windows/sshd.js): the other side sends `ssh.key`; with "Let {name} open a terminal on {me}" on
// and the OpenSSH server running, its key goes into ~/.ssh/authorized_keys with the marker
// `macshare:<peer id>` (no agent or X11 forwarding), and we answer `ssh.info` with this computer's
// user, port and host keys. Set up installs and starts the server (pkexec, once).
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const P = require('../shared/protocol.js');

const T = P.T;
const OPTIONS = 'no-agent-forwarding,no-X11-forwarding,no-port-forwarding';
const OURS = / macshare:[A-Za-z0-9._-]*$/; // the marker at the end of each line we add
const KEYS = path.join(os.homedir(), '.ssh', 'authorized_keys');
const clean = (id) => String(id || '').replace(/[^A-Za-z0-9._-]/g, '');

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, out, stderr) => resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : 0, out: String(out || '').trim(), err: String(stderr || '').trim() }));
  });
}

const which = (cmd) => (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').some((d) => d && fs.existsSync(path.join(d, cmd)));

// The port sshd listens on (sshd_config Port, else 22).
function sshPort() {
  try {
    const m = /^\s*Port\s+(\d+)/mi.exec(fs.readFileSync('/etc/ssh/sshd_config', 'utf8'));
    if (m) return Number(m[1]);
  } catch (_) { /* default */ }
  return 22;
}

// Something answers on the port (socket-activated sshd counts as running).
function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

function hostKeys() {
  try {
    return fs.readdirSync('/etc/ssh').filter((f) => /^ssh_host_\w+_key\.pub$/.test(f))
      .map((f) => fs.readFileSync(path.join('/etc/ssh', f), 'utf8').trim().split(/\s+/).slice(0, 2).join(' '))
      .filter((k) => /^\S+ [A-Za-z0-9+/=]+$/.test(k));
  } catch (_) {
    return [];
  }
}

class Sshd {
  // opts: link, settings (shared), save(), onChange()
  //   bus, consent (shared/consent.js): Multi-device. Every device's key is heard and kept by its own id,
  //   and each device's own pair decides it ("Let {name} open a terminal"): on the facade a key from a
  //   device that wasn't selected was dropped, and a crossing to a pair with it off removed every
  //   device's key (#313).
  constructor(opts) {
    Object.assign(this, opts);
    this.service = 'unknown'; // 'running' | 'stopped' | 'missing' | 'unknown'
    this.pending = new Map(); // device id -> its last ssh.key line
    this.infos = new Map(); // device id -> the last ssh.info we sent it ({enabled, why})
    this.busy = false;
    this.message = '';
    const gone = (id) => { this.pending.delete(id); this.infos.delete(id); this.onChange(); };
    if (this.bus) {
      this.bus.on(T.SSH_KEY, (m, from) => this._onKey(m, from));
      this.bus.on(T.SSH_FORGET, (m, from) => this._forget(from));
      this.bus.onPeer('closed', gone);
    } else {
      this.link.on(T.SSH_KEY, (m) => this._onKey(m, this.peerId()));
      this.link.on(T.SSH_FORGET, () => this._forget(this.peerId()));
      this.link.on('closed', () => { this.pending.clear(); this.infos.clear(); this.onChange(); });
    }
    this.refresh();
  }

  get cfg() {
    return this.settings.terminal;
  }

  async refresh() {
    const port = sshPort();
    if (await listening(port)) this.service = 'running';
    else this.service = (which('sshd') || fs.existsSync('/usr/sbin/sshd')) ? 'stopped' : 'missing';
    this.onChange();
  }

  // The other computer's id (one-to-one).
  peerId() {
    const s = this.link.snapshot().session;
    return s && s.id ? String(s.id) : 'peer';
  }

  // The device the Terminal page shows.
  _shown() {
    return this.bus ? this.bus.selectedId() : this.peerId();
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
      this._removeAll();
      const id = this.peerId();
      return this.pending.has(id) ? this._info(id, false, 'not_allowed') : this.onChange();
    }
    const ids = this.bus ? new Set([...this.pending.keys(), ...Object.keys(this.cfg.installedKeys || {})]) : [this.peerId()];
    for (const id of ids) await this._applyOne(id);
    this.onChange();
  }

  async _applyOne(id) {
    if (!this._allowed(id)) { // off for this pair: its key comes out, the others stay
      if (this._installed(id)) this._forgetLine(id);
      return this.pending.has(id) ? this._info(id, false, 'not_allowed') : this.onChange();
    }
    const pub = this.pending.get(id);
    if (!pub) return this.onChange();
    await this.refresh();
    if (this.service !== 'running') return this._info(id, false, 'remote_login_off');
    const line = OPTIONS + ' ' + pub + ' macshare:' + clean(id);
    const digest = crypto.createHash('sha256').update(line).digest('hex');
    if (this._installed(id) !== digest || !this._has(line)) {
      try {
        this._install(line, id);
        this._mark(digest, id);
        this.save();
        this.message = '';
      } catch (e) {
        this.message = 'Couldn’t add {name}’s key: ' + e.message;
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

  _has(line) {
    try { return fs.readFileSync(KEYS, 'utf8').split('\n').includes(line); } catch (_) { return false; }
  }

  // Replace this device's marked line (sshd wants ~/.ssh 700 and the file 600).
  _install(line, id) {
    const marker = ' macshare:' + clean(id);
    fs.mkdirSync(path.dirname(KEYS), { recursive: true, mode: 0o700 });
    const keep = fs.existsSync(KEYS) ? fs.readFileSync(KEYS, 'utf8').split(/\r?\n/).filter((l) => l && !l.endsWith(marker)) : [];
    fs.writeFileSync(KEYS, keep.concat(line).join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(KEYS, 0o600);
  }

  // Unpaired (one-to-one), or the Terminal off there: every line we added comes out (any computer's
  // marker). The keys stay in memory: switching on again adds them. Unpaired: dropped from memory too.
  revokeAll() {
    this.pending.clear();
    this._removeAll();
    this.onChange();
  }

  _removeAll() {
    if (!this.cfg.installedKey) return;
    try {
      if (fs.existsSync(KEYS)) fs.writeFileSync(KEYS, fs.readFileSync(KEYS, 'utf8').split(/\r?\n/).filter((l) => l && !OURS.test(l)).join('\n') + '\n');
      this.cfg.installedKey = '';
      this.cfg.installedKeys = {};
      this.save();
      this.message = '';
    } catch (e) {
      this.message = '{Name}’s key is still installed: ' + e.message;
    }
  }

  // The device said its Terminal forgot this computer (ssh.forget): its key comes out.
  _forget(id) {
    this.pending.delete(id);
    this._forgetLine(id);
    this.onChange();
  }

  _forgetLine(id) {
    if (!this.cfg.installedKey) return;
    const marker = ' macshare:' + clean(id);
    try {
      if (fs.existsSync(KEYS)) fs.writeFileSync(KEYS, fs.readFileSync(KEYS, 'utf8').split(/\r?\n/).filter((l) => l && !l.endsWith(marker)).join('\n') + '\n');
      this._mark('', id);
      this.save();
    } catch (e) {
      this.message = '{Name}’s key is still installed: ' + e.message;
    }
  }

  // Install (apt, dnf, zypper or pacman), enable and start the OpenSSH server: one password prompt.
  async setup() {
    if (this.busy) return;
    this.busy = true;
    this.message = '';
    this.onChange();
    const script = [
      'if ! command -v sshd >/dev/null 2>&1 && ! [ -x /usr/sbin/sshd ]; then',
      '  if [ -e /etc/NIXOS ]; then echo "On NixOS, enable services.openssh.enable = true; in configuration.nix" >&2; exit 3;',
      '  elif command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server;',
      '  elif command -v dnf >/dev/null; then dnf install -y openssh-server;',
      '  elif command -v zypper >/dev/null; then zypper --non-interactive install openssh-server;',
      '  elif command -v pacman >/dev/null; then pacman -S --noconfirm openssh; fi',
      'fi',
      'systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd',
    ].join('\n');
    const r = await run('pkexec', ['sh', '-c', script], 600000);
    if (!r.ok) this.message = r.code === 126 ? 'The password prompt was closed' : 'Setup failed: ' + (r.err.split('\n').pop() || 'pkexec failed');
    this.busy = false;
    await this.refresh();
    await this.apply();
  }

  _info(id, enabled, why) {
    const msg = { t: T.SSH_INFO, enabled };
    if (enabled) {
      msg.user = os.userInfo().username;
      msg.port = sshPort();
      msg.hostKeys = hostKeys();
    } else msg.why = why;
    this._send(id, msg);
    this.infos.set(id, { enabled, why: why || '' });
    this.onChange();
  }

  // The Terminal page: the device it shows.
  view() {
    const id = this._shown();
    return { service: this.service, busy: this.busy, message: this.message, macAsked: !!(id && this.pending.has(id)), info: (id && this.infos.get(id)) || null };
  }
}

module.exports = Sshd;
