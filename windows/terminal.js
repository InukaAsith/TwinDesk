// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal, this PC → the other computer (a Mac, another PC or Linux): an ed25519 key made once,
// handed over the paired link (ssh.key); the other side's host keys come back (ssh.info) and are
// pinned in our own known_hosts, so ssh never asks for a password or "trust this host?". A
// `Host twindesk` entry in %USERPROFILE%\.ssh\config makes `ssh twindesk` work in any terminal;
// Open Terminal starts Windows Terminal with it.
const { app } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../shared/protocol.js');
const SshConfig = require('../shared/sshconfig.js');

const T = P.T;
const SSH_DIR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH');
const SSH = path.join(SSH_DIR, 'ssh.exe');
const KEYGEN = path.join(SSH_DIR, 'ssh-keygen.exe');
const WHY = {
  remote_login_off: 'Remote Login is off on {name} (System Settings → General → Sharing).',
  sshd_off: 'The SSH server isn’t running on {name} (its Terminal tab → Set up).',
  not_allowed: '{Name} doesn’t allow shells from {me} (its Terminal tab).',
};

class Terminal {
  // opts: link, settings (shared), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.dir = path.join(app.getPath('userData'), 'ssh');
    this.key = path.join(this.dir, 'macshare_ed25519');
    this.knownHosts = path.join(this.dir, 'known_hosts');
    this.info = null; // last ssh.info
    this.status = 'off';
    this.message = '';
    // Older versions wrote a `macshare` command; `ssh twindesk` replaces it.
    try { fs.rmSync(path.join(app.getPath('userData'), 'bin', 'macshare.cmd'), { force: true }); } catch (_) { /* gone */ }

    this.link.on('welcome', () => this.apply());
    this.link.on('closed', () => { this.info = null; this._set(this.cfg.enabled ? 'no_mac' : 'off', ''); });
    this.link.on(T.SSH_INFO, (m) => this._onInfo(m));
  }

  get cfg() {
    return this.settings.terminal;
  }

  get available() {
    return fs.existsSync(SSH) && fs.existsSync(KEYGEN);
  }

  // Call on welcome and after the Terminal switch changed.
  async apply() {
    if (!this.cfg.enabled) {
      if (this.info) this.link.send({ t: T.SSH_FORGET });
      this.info = null;
      try { SshConfig.setHost(null); } catch (_) { /* config not writable */ }
      return this._set('off', '');
    }
    if (!this.available) return this._set('error', 'Windows’ OpenSSH client is missing (Settings → System → Optional features → OpenSSH Client).');
    if (this.link.status.state !== 'connected') return this._set('no_mac', '');
    try {
      const pub = await this._ensureKey();
      this._set('waiting', '');
      this.link.send({ t: T.SSH_KEY, pub });
    } catch (e) {
      this._set('error', 'Couldn’t make an SSH key: ' + e.message);
    }
  }

  async _ensureKey() {
    if (!fs.existsSync(this.key + '.pub')) {
      fs.mkdirSync(this.dir, { recursive: true });
      await run(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'macshare@' + os.hostname(), '-f', this.key]);
    }
    return fs.readFileSync(this.key + '.pub', 'utf8').trim();
  }

  _onInfo(m) {
    if (!this.cfg.enabled) return;
    this.info = m;
    if (!m.enabled) {
      const why = m.why === 'remote_login_off' && this.link.peerOs !== P.OS.MAC ? 'sshd_off' : m.why;
      return this._set('unavailable', WHY[why] || '{Name} can’t open a shell right now.');
    }
    const keys = (Array.isArray(m.hostKeys) ? m.hostKeys : [])
      .map((k) => String(k).trim().split(/\s+/).slice(0, 2).join(' '))
      .filter((k) => /^(ssh|ecdsa)-\S+ [A-Za-z0-9+/=]+$/.test(k));
    if (!keys.length || typeof m.user !== 'string' || !/^[A-Za-z0-9._@ -]{1,100}$/.test(m.user)) return this._set('error', '{Name} sent no usable host key or user name.');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.knownHosts, SshConfig.knownHosts(keys));
    try {
      this._writeHost();
    } catch (e) {
      return this._set('error', 'Couldn’t write the twindesk entry in .ssh\\config: ' + e.message);
    }
    this._set('ready', '');
  }

  // `Host twindesk` for the paired computer (its address can change; rewritten on every open).
  _writeHost() {
    SshConfig.setHost({ address: this.link.snapshot().link.address, port: this.info.port, user: this.info.user,
      identityFile: this.key, knownHostsFile: this.knownHosts });
  }

  // Opens Windows Terminal (or a console) with `ssh twindesk`.
  // Through Bluetooth there's no address ssh can reach (the session runs through a local pipe).
  get onBle() {
    const c = this.link.current;
    return !!c && c.transport === 'ble';
  }

  open() {
    if (this.status !== 'ready' || this.onBle) return;
    try { this._writeHost(); } catch (e) { return this._set('error', e.message); }
    const opts = { detached: true, stdio: 'ignore', windowsHide: false };
    const title = (this.link.snapshot().link.macName || 'TwinDesk').replace(/["&|<>^]/g, '');
    const wt = spawn('wt.exe', ['--title', title, SSH, SshConfig.ALIAS], opts);
    wt.on('error', () => spawn('cmd.exe', ['/c', 'start', '', SSH, SshConfig.ALIAS], { ...opts, shell: false }).unref());
    wt.unref();
  }

  _set(status, message) {
    this.status = status;
    this.message = message;
    this.onChange();
  }

  view() {
    if (this.status === 'ready' && this.onBle) {
      return { status: 'unavailable', message: 'The terminal doesn’t work over Bluetooth. Connect with Wi-Fi Direct, or join {name}’s network.', user: this.info && this.info.user, command: 'ssh ' + SshConfig.ALIAS };
    }
    return { status: this.status, message: this.message, user: this.info && this.info.user, command: 'ssh ' + SshConfig.ALIAS };
  }
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) =>
      (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0])) : resolve(String(stdout))));
  });
}

module.exports = Terminal;
