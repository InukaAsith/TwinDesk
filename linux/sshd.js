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
const OPTIONS = 'no-agent-forwarding,no-X11-forwarding';
const KEYS = path.join(os.homedir(), '.ssh', 'authorized_keys');

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
  constructor(opts) {
    Object.assign(this, opts);
    this.service = 'unknown'; // 'running' | 'stopped' | 'missing' | 'unknown'
    this.pendingKey = null;   // the other side's last ssh.key line
    this.busy = false;
    this.message = '';
    this.lastInfo = null;
    this.link.on(T.SSH_KEY, (m) => this._onKey(m));
    this.link.on(T.SSH_FORGET, () => this._forget());
    this.link.on('closed', () => { this.pendingKey = null; this.lastInfo = null; this.onChange(); });
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

  peerId() {
    const s = this.link.snapshot().session;
    return s && s.id ? String(s.id) : 'peer';
  }

  async _onKey(m) {
    const pub = typeof m.pub === 'string' ? m.pub.trim().split(/\s+/).slice(0, 2).join(' ') : '';
    if (!/^(ssh-ed25519|ecdsa-sha2-\S+|ssh-rsa) [A-Za-z0-9+/=]+$/.test(pub)) return;
    this.pendingKey = pub;
    await this.apply();
  }

  // Called on a key from the other side and when the switch changes.
  async apply() {
    if (!this.pendingKey) return this.onChange();
    if (!this.cfg.allowMac) return this._info(false, 'not_allowed');
    await this.refresh();
    if (this.service !== 'running') return this._info(false, 'remote_login_off');
    const line = OPTIONS + ' ' + this.pendingKey + ' macshare:' + this.peerId();
    const digest = crypto.createHash('sha256').update(line).digest('hex');
    if (this.cfg.installedKey !== digest || !this._has(line)) {
      try {
        this._install(line);
        this.cfg.installedKey = digest;
        this.save();
        this.message = '';
      } catch (e) {
        this.message = 'Couldn’t add {name}’s key: ' + e.message;
        return this._info(false, 'not_allowed');
      }
    }
    this._info(true);
  }

  _has(line) {
    try { return fs.readFileSync(KEYS, 'utf8').split('\n').includes(line); } catch (_) { return false; }
  }

  // Replace our marked line (sshd wants ~/.ssh 700 and the file 600).
  _install(line) {
    const marker = ' macshare:' + this.peerId();
    fs.mkdirSync(path.dirname(KEYS), { recursive: true, mode: 0o700 });
    const keep = fs.existsSync(KEYS) ? fs.readFileSync(KEYS, 'utf8').split(/\r?\n/).filter((l) => l && !l.endsWith(marker)) : [];
    fs.writeFileSync(KEYS, keep.concat(line).join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(KEYS, 0o600);
  }

  _forget() {
    this.pendingKey = null;
    if (!this.cfg.installedKey) return this.onChange();
    const marker = ' macshare:' + this.peerId();
    try {
      if (fs.existsSync(KEYS)) fs.writeFileSync(KEYS, fs.readFileSync(KEYS, 'utf8').split(/\r?\n/).filter((l) => l && !l.endsWith(marker)).join('\n') + '\n');
      this.cfg.installedKey = '';
      this.save();
    } catch (e) {
      this.message = '{Name}’s key is still installed: ' + e.message;
    }
    this.onChange();
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

  _info(enabled, why) {
    const msg = { t: T.SSH_INFO, enabled };
    if (enabled) {
      msg.user = os.userInfo().username;
      msg.port = sshPort();
      msg.hostKeys = hostKeys();
    } else msg.why = why;
    this.link.send(msg);
    this.lastInfo = { enabled, why: why || '' };
    this.onChange();
  }

  view() {
    return { service: this.service, busy: this.busy, message: this.message, macAsked: !!this.pendingKey, info: this.lastInfo || null };
  }
}

module.exports = Sshd;
