// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal, PC -> Mac: the PC's public key arrives over
// the paired link and goes into ~/.ssh/authorized_keys with a `macshare:<pcId>` marker; the Mac
// answers with its user, port and host keys so the PC never has to trust-on-first-use.
//
// Events: 'change' — this.view changed.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const AUTH_KEYS = path.join(SSH_DIR, 'authorized_keys');
const KEY_RE = /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ssh-rsa) ([A-Za-z0-9+/]+={0,3})(?: .*)?$/;
const OPTIONS = 'no-agent-forwarding,no-X11-forwarding';
const marker = (id) => `macshare:${String(id).replace(/[^A-Za-z0-9._-]/g, '')}`;

function sshdUp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: 22, timeout: 600 });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

function hostKeys() {
  const out = [];
  for (const t of ['ed25519', 'ecdsa', 'rsa']) {
    try {
      const [type, b64] = fs.readFileSync(`/etc/ssh/ssh_host_${t}_key.pub`, 'utf8').trim().split(/\s+/);
      if (type && b64) out.push(`${type} ${b64}`);
    } catch { /* that key type isn't there */ }
  }
  return out;
}

function readKeys() {
  try {
    return fs.readFileSync(AUTH_KEYS, 'utf8').split('\n');
  } catch {
    return [];
  }
}

// Replace (or remove, with line = null) the line carrying this marker. Keeps every other line.
function writeKey(mark, line) {
  const lines = readKeys().filter((l) => l && !l.endsWith(` ${mark}`));
  if (line) lines.push(line);
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SSH_DIR, 0o700);
  const tmp = `${AUTH_KEYS}.macshare-tmp`;
  fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  fs.renameSync(tmp, AUTH_KEYS);
}

class Terminal extends EventEmitter {
  // mesh { bus, consent } (Multi-device): every device's key is heard, and each device's own pair decides
  // it (shared/consent.js); on the facade only the selected device was answered (#313).
  constructor(server, getSettings, mesh = null) {
    super();
    this.server = server;
    this.getSettings = getSettings;
    this.bus = mesh && mesh.bus;
    this.consent = mesh && mesh.consent;
    this.remoteLogin = null; // sshd reachable on 127.0.0.1:22
    this.keys = new Map(); // pcId -> pub line offered on this run (to reinstall after "on" again)

    const forget = (id) => {
      this.keys.delete(id);
      this._remove(id);
    };
    if (this.bus) {
      this.bus.on(P.T.SSH_KEY, (m, from) => this._onKey(m, { deviceId: from }));
      this.bus.on(P.T.SSH_FORGET, (_m, from) => forget(from));
    } else {
      server.on(`t:${P.T.SSH_KEY}`, (m, ctx) => this._onKey(m, ctx));
      server.on(`t:${P.T.SSH_FORGET}`, (_m, ctx) => forget(ctx.deviceId));
    }
    this.refresh();
    setInterval(() => this.refresh(), 15000);
  }

  get allow() {
    return !!this.getSettings().terminal.allowPc;
  }

  // "Allow {name} to open a shell" for that device: its own pair in Multi-device.
  _allowed(id) {
    return this.consent ? this.consent.get(id, 'terminal', 'out') : this.allow;
  }

  async refresh() {
    const up = await sshdUp();
    if (up === this.remoteLogin) return;
    const was = this.remoteLogin;
    this.remoteLogin = up;
    this.emit('change');
    if (was === false && up) this._answerCurrent(); // Remote Login was just turned on
  }

  async _onKey(m, ctx) {
    const pub = String(m.pub || '').trim();
    const k = KEY_RE.exec(pub);
    if (!k || pub.length > 4096) return console.log('[terminal] ignored a malformed ssh.key');
    this.keys.set(ctx.deviceId, `${k[1]} ${k[2]}`);
    await this._answer(ctx);
  }

  async _answer(ctx) {
    const key = this.keys.get(ctx.deviceId);
    if (!key) return;
    const msg = (fields) => ({ t: P.T.SSH_INFO, user: os.userInfo().username, port: 22, hostKeys: hostKeys(), ...fields });
    const send = (fields) => (this.bus ? this.bus.send(ctx.deviceId, msg(fields)) : this.server.send(ctx, msg(fields)));
    if (!this._allowed(ctx.deviceId)) {
      this._remove(ctx.deviceId);
      return send({ enabled: false, why: 'not_allowed' });
    }
    try {
      writeKey(marker(ctx.deviceId), `${OPTIONS} ${key} ${marker(ctx.deviceId)}`);
    } catch (e) {
      console.error(`[terminal] authorized_keys: ${e.message}`);
      return send({ enabled: false, why: 'not_allowed' });
    }
    this.remoteLogin = await sshdUp();
    this.emit('change');
    send(this.remoteLogin ? { enabled: true } : { enabled: false, why: 'remote_login_off' });
  }

  // Every device that offered a key (Multi-device), else the one connected.
  _answerCurrent() {
    if (this.bus) {
      const up = new Set(this.bus.connectedIds());
      for (const id of this.keys.keys()) if (up.has(id)) this._answer({ deviceId: id });
      return;
    }
    const c = this.server.current;
    if (c) this._answer(c);
  }

  _remove(deviceId) {
    try {
      writeKey(marker(deviceId), null);
    } catch (e) {
      console.error(`[terminal] authorized_keys: ${e.message}`);
    }
    this.emit('change');
  }

  // After the "Allow the PC to open a shell" switch changed.
  applySettings() {
    for (const l of readKeys()) { // off for a device: its key comes out, the others stay
      const m = / macshare:([A-Za-z0-9._-]+)$/.exec(l);
      if (m && !this._allowed(m[1])) this._remove(m[1]);
    }
    this._answerCurrent();
    this.emit('change');
  }

  // A PC was forgotten: it may not log in any more.
  forget(deviceId) {
    this.keys.delete(deviceId);
    this._remove(deviceId);
  }

  get view() {
    const installed = readKeys().filter((l) => / macshare:/.test(l)).length;
    return { remoteLogin: this.remoteLogin, installed, user: os.userInfo().username };
  }
}

module.exports = { Terminal };
