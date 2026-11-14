// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM on Linux (docs/full-kvm.md): the system service, as root, from systemd
// (twindesk-fullkvm.service, written by install.sh). It runs the helper's uinput backend
// (linux-helper, MACSHARE_HELPER_BACKEND=uinput: evdev capture and uinput injection, below every
// display server), so the mesh's mouse and keyboard work on the lock screen, in polkit dialogs and,
// System-wide, at the login screen, and hands it to one client over /run/twindesk/kvm.sock:
//   - someone signed in on seat0: their TwinDesk (the socket is theirs, mode 0600);
//   - the login screen, System-wide: the machine node (headless.js), started here as the unprivileged
//     `twindesk` account, stopped when someone signs in (their app takes over).
// The socket carries the helper's own JSON lines, for the mouse-and-keyboard commands only: anything
// else is refused, so this root process never reads a file or runs anything for its client, and it
// has no network of its own (the native input lane stays off: the client's Node lane injects here).
// One helper per connection: a client that goes leaves nothing captured, grabbed or held.
//   ELECTRON_RUN_AS_NODE=1 <electron> linux/fullkvm/service.js   (or node)
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');

const CONF = process.env.TWINDESK_FULLKVM_CONF || '/etc/twindesk/fullkvm.json';
const RUN = process.env.TWINDESK_FULLKVM_RUN || '/run/twindesk';
const SOCK = path.join(RUN, 'kvm.sock');
const MACHINE = '/var/lib/twindesk'; // the machine node's folder (System-wide)
const ACCOUNT = 'twindesk';
const ROOT = path.join(__dirname, '..', '..'); // the app: linux/, shared/, linux-helper/
const BIN = path.join(ROOT, 'linux-helper', 'bin', 'macshare-linuxhelper-multi');
const BIN_ONE = path.join(ROOT, 'linux-helper', 'bin', 'macshare-linuxhelper');
const SEAT_MS = 1000;
const MAX_LINE = 256 * 1024;
// The helper's mouse-and-keyboard commands (linux-helper/src/main.c, its uinput branch).
const ALLOWED = new Set(['ping', 'keepalive', 'kvmConfig', 'screens', 'capture', 'place', 'armReturn', 'inject', 'pen', 'touch', 'releaseAll', 'watchRelease', 'moveTo', 'info']);

const log = (...a) => console.log('[fullkvm]', ...a);

function readConf() {
  try {
    const c = JSON.parse(fs.readFileSync(CONF, 'utf8'));
    return { mode: c && c.mode === 'system' ? 'system' : 'simple' };
  } catch (_) {
    return { mode: 'simple' };
  }
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out))));
}

// Who seat0 belongs to now: { kind: 'user', uid } (signed in: the lock screen too, it is their
// session), { kind: 'greeter' } (the login screen) or { kind: 'none' }.
async function seatOwner() {
  const sid = (await run('loginctl', ['show-seat', 'seat0', '-p', 'ActiveSession', '--value'])).trim();
  if (!sid) return { kind: 'none' };
  const props = {};
  for (const line of (await run('loginctl', ['show-session', sid, '-p', 'User', '-p', 'Class', '-p', 'State'])).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  if (props.Class === 'greeter') return { kind: 'greeter' };
  const uid = Number(props.User);
  if (props.Class === 'user' && Number.isInteger(uid) && uid > 0) return { kind: 'user', uid };
  return { kind: 'none' };
}

function accountIds() {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(ACCOUNT + ':'));
    const f = line.split(':');
    return { uid: Number(f[2]), gid: Number(f[3]) };
  } catch (_) {
    return null;
  }
}

const same = (a, b) => a.kind === b.kind && a.uid === b.uid;

class Service {
  constructor() {
    this.conf = readConf();
    this.owner = { kind: 'none' };
    this.client = null; // { sock, helper }
    this.node = null; // the machine node's process
    this.server = null;
  }

  start() {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o755 });
    try { fs.unlinkSync(SOCK); } catch (_) { /* none left */ }
    const old = process.umask(0o177); // born 0600 root: nobody connects before it is given to its owner
    this.server = net.createServer((sock) => this._accept(sock));
    this.server.listen(SOCK, () => {
      process.umask(old);
      log(`listening on ${SOCK} (${this.conf.mode})`);
      this._seat();
    });
    this.server.on('error', (e) => { log('socket:', e.message); process.exit(1); });
    setInterval(() => this._seat(), SEAT_MS);
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => this.stop());
    process.on('SIGHUP', () => { this.conf = readConf(); log('mode', this.conf.mode); this._apply(true); });
  }

  stop() {
    this._drop();
    this._stopNode();
    try { fs.unlinkSync(SOCK); } catch (_) { /* gone */ }
    process.exit(0);
  }

  async _seat() {
    const now = await seatOwner();
    if (same(now, this.owner)) return;
    log('seat0:', now.kind === 'user' ? 'uid ' + now.uid : now.kind);
    this.owner = now;
    this._apply(false);
  }

  // The socket goes to the seat's owner; whoever had it is dropped (and lets go of everything).
  _apply(confChanged) {
    const o = this.owner;
    const system = this.conf.mode === 'system';
    let uid = 0;
    if (o.kind === 'user') uid = o.uid;
    else if (o.kind === 'greeter' && system) { const a = accountIds(); if (a) uid = a.uid; }
    if (uid !== this.uid || confChanged) {
      this._drop();
      try { fs.chownSync(SOCK, uid, -1); fs.chmodSync(SOCK, 0o600); } catch (e) { log('chown:', e.message); }
      this.uid = uid;
    }
    if (o.kind === 'greeter' && system) this._startNode();
    else this._stopNode();
  }

  _accept(sock) {
    // The file mode already said who may connect; one client at a time, the newest wins.
    this._drop();
    const bin = fs.existsSync(BIN) ? BIN : BIN_ONE;
    const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', MACSHARE_HELPER_BACKEND: 'uinput' };
    const helper = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const c = { sock, helper, inBuf: '', outBuf: '' };
    this.client = c;
    log('client connected, helper', helper.pid);
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (d) => { if (this.client === c) sock.write(d); });
    helper.stderr.on('data', (d) => log('helper:', String(d).trim()));
    helper.stdin.on('error', () => {});
    helper.on('exit', (code) => {
      log('helper exited', code);
      if (this.client === c) this._drop();
    });
    sock.setEncoding('utf8');
    sock.on('data', (d) => this._fromClient(c, d));
    sock.on('error', () => {});
    sock.on('close', () => { if (this.client === c) this._drop(); });
  }

  _fromClient(c, d) {
    c.inBuf += d;
    if (c.inBuf.length > MAX_LINE) { log('line too long: dropped'); return this._drop(); }
    let i;
    while ((i = c.inBuf.indexOf('\n')) >= 0) {
      const line = c.inBuf.slice(0, i).trim();
      c.inBuf = c.inBuf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
      if (!ALLOWED.has(msg.cmd)) {
        if (msg.id !== undefined) c.sock.write(JSON.stringify({ id: msg.id, ok: false, error: 'not allowed through Full KVM' }) + '\n');
        continue;
      }
      c.helper.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  // The client goes: its helper gets EOF, releases every key and button, ungrabs and exits.
  _drop() {
    const c = this.client;
    if (!c) return;
    this.client = null;
    try { c.helper.stdin.end(); } catch (_) { /* gone */ }
    setTimeout(() => { try { c.helper.kill('SIGKILL'); } catch (_) { /* gone */ } }, 2000).unref();
    try { c.sock.destroy(); } catch (_) { /* gone */ }
    log('client dropped');
  }

  // The machine node (System-wide, the login screen): the mesh without anyone's app, as `twindesk`.
  _startNode() {
    if (this.node) return;
    const a = accountIds();
    const script = path.join(ROOT, 'shared', 'fullkvm', 'headless.js');
    if (!a || !fs.existsSync(script) || !fs.existsSync(path.join(MACHINE, 'device.json'))) {
      log('System-wide: no machine node (', !a ? 'no account' : !fs.existsSync(script) ? 'no headless.js' : 'nothing copied to ' + MACHINE, ')');
      return;
    }
    const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: MACHINE, ELECTRON_RUN_AS_NODE: '1', TWINDESK_MACHINE_DIR: MACHINE, TWINDESK_KVM_SOCK: SOCK };
    const node = spawn(process.execPath, [script], { uid: a.uid, gid: a.gid, cwd: MACHINE, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.node = node;
    log('machine node started', node.pid);
    node.stdout.on('data', (d) => process.stdout.write('[node] ' + d));
    node.stderr.on('data', (d) => process.stderr.write('[node] ' + d));
    node.on('exit', (code) => {
      if (this.node !== node) return;
      this.node = null;
      log('machine node exited', code);
      if (this.owner.kind === 'greeter' && this.conf.mode === 'system') setTimeout(() => this._apply(false), 3000);
    });
  }

  _stopNode() {
    const node = this.node;
    if (!node) return;
    this.node = null;
    node.kill('SIGTERM');
    setTimeout(() => { try { node.kill('SIGKILL'); } catch (_) { /* gone */ } }, 3000).unref();
    log('machine node stopped');
  }
}

function main() {
  if (process.getuid && process.getuid() !== 0) { console.error('the Full KVM service runs as root'); process.exit(1); }
  new Service().start();
}

if (require.main === module) main();

module.exports = { ALLOWED, Service, readConf, main }; // main: from the installed boot file (install.sh)
