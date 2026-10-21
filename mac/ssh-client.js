// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal, this Mac -> the other computer (a PC, a Mac or Linux): send this Mac's key with
// `ssh.key`; when the other side answers `ssh.info {enabled}`, write a pinned `Host twindesk`
// entry into ~/.ssh/config so `ssh twindesk` works with no password and no "trust this host?"
// question.
//
// Events: 'change' — this.view changed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const SshConfig = require('../shared/sshconfig.js');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const KEY = path.join(SSH_DIR, 'macshare_ed25519');
const KNOWN = path.join(SSH_DIR, 'macshare_known_hosts');
const safe = (s) => /^[A-Za-z0-9._@ -]{1,100}$/.test(s);

class SshClient extends EventEmitter {
  constructor(server, getSettings) {
    super();
    this.server = server;
    this.getSettings = getSettings;
    this.status = { ready: false, why: null, user: null };
    server.on('client', () => this._offer());
    // Through Bluetooth the session's address is the pipe's own end (127.0.0.1: ssh would reach
    // this Mac): not ready there; on Wi-Fi again, asked again for the new address.
    server.on('transport', () => this._offer());
    server.on(`t:${P.T.SSH_INFO}`, (m, ctx) => this._onInfo(m, ctx));
  }

  get enabled() {
    return !!this.getSettings().terminal.connectPc;
  }

  _pub() {
    if (!fs.existsSync(KEY)) {
      fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
      execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `macshare@${os.hostname().replace(/\.local$/, '')}`, '-f', KEY]);
    }
    return fs.readFileSync(`${KEY}.pub`, 'utf8').trim();
  }

  _offer() {
    if (!this.enabled || !this.server.current) return;
    try {
      this.server.sendToClient({ t: P.T.SSH_KEY, pub: this._pub() });
      this.status = { ready: false, why: 'waiting', user: null };
    } catch (e) {
      this.status = { ready: false, why: `key: ${e.message}`, user: null };
    }
    this.emit('change');
  }

  _onInfo(m, ctx) {
    if (!this.enabled) return;
    if (!m.enabled) {
      this.status = { ready: false, why: m.why || 'not_allowed', user: null };
      return this.emit('change');
    }
    if (ctx.transport === 'ble') {
      SshConfig.setHost(null);
      this.status = { ready: false, why: 'bluetooth', user: null };
      return this.emit('change');
    }
    const user = String(m.user || '');
    const port = Number(m.port) || 22;
    const keys = (Array.isArray(m.hostKeys) ? m.hostKeys : []).map(String).filter((k) => /^[a-z0-9-]+ [A-Za-z0-9+/=]+$/.test(k));
    if (!safe(user) || !keys.length) {
      this.status = { ready: false, why: 'bad answer from the other computer', user: null };
      return this.emit('change');
    }
    fs.writeFileSync(KNOWN, SshConfig.knownHosts(keys), { mode: 0o600 });
    SshConfig.setHost({ address: ctx.address, port, user, identityFile: KEY, knownHostsFile: KNOWN });
    this.status = { ready: true, why: null, user };
    this.emit('change');
  }

  // After the "Open shells there" switch changed.
  applySettings() {
    if (this.enabled) return this._offer();
    if (this.server.current) this.server.sendToClient({ t: P.T.SSH_FORGET });
    SshConfig.setHost(null);
    fs.rmSync(KNOWN, { force: true });
    this.status = { ready: false, why: null, user: null };
    this.emit('change');
  }

  openShell() {
    if (!this.status.ready) return;
    execFile('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "ssh ${SshConfig.ALIAS}"`, '-e', 'tell application "Terminal" to activate'], () => {});
  }

  get view() {
    return { ...this.status, alias: SshConfig.ALIAS };
  }
}

module.exports = { SshClient };
