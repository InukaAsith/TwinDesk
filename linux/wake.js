// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Each side sends `wol.info {macs, address}`
// after welcome; we keep it per paired device (settings.wake.peers) so Overview › Paired can wake a
// sleeping or switched-off computer with a magic packet (6 × 0xFF, then its MAC address 16 times) to
// every broadcast address and its last address, ports 9 and 7. The link keeps retrying by itself, so
// it connects as soon as the other computer is up. General shows whether this computer's wired
// adapters may wake it (sysfs power/wakeup), and its switch turns that on or off (ethtool wol g +
// sysfs, once through pkexec). Copy of windows/wake.js.
'use strict';

const dgram = require('dgram');
const os = require('os');
const P = require('../shared/protocol.js');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { interfaces } = require('./discovery');

const T = P.T;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

// MAC addresses of the interfaces we are reachable on (non-internal IPv4).
function ownMacs() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && MAC_RE.test(i.mac) && i.mac !== '00:00:00:00:00:00') out.add(i.mac);
    }
  }
  return [...out];
}

function magic(mac) {
  const bytes = Buffer.from(mac.replace(/:/g, ''), 'hex');
  const buf = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) bytes.copy(buf, 6 + i * 6);
  return buf;
}

// Up physical adapters (they have a device/ in sysfs): wakeup armed?
function adapters() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync('/sys/class/net'); } catch (_) { return out; }
  for (const name of names) {
    const base = path.join('/sys/class/net', name);
    if (!fs.existsSync(path.join(base, 'device'))) continue; // virtual (lo, docker, bridges, tun)
    const read = (f) => { try { return fs.readFileSync(path.join(base, f), 'utf8').trim(); } catch (_) { return ''; } };
    if (read('operstate') !== 'up') continue;
    if (fs.existsSync(path.join(base, 'wireless'))) continue; // Wi-Fi rarely wakes from off
    out.push({ name, armed: read('device/power/wakeup') === 'enabled', magic: '' });
  }
  return out;
}

const pkexec = (script) => new Promise((resolve, reject) => {
  execFile('pkexec', ['sh', '-c', script], { timeout: 120000 }, (err, _o, stderr) => (err ? reject(new Error(err.code === 126 || err.code === 127 ? 'cancelled' : String(stderr || err.message).trim())) : resolve()));
});

class Wake {
  // opts: link, settings (shared, .wake), save(), onChange(), address() (the one the peer can reach)
  //   bus, peer(id) → {name, os}: Multi-device (the hub's bus): every device is told how to wake this one
  //   when it connects, and learned from whichever device tells, not only the selected one (#313)
  constructor(opts) {
    Object.assign(this, opts);
    this.state = { checked: false, on: null, busy: false, adapters: [], error: '' };
    this.last = null; // {id, at}: the last wake we sent

    const info = () => ({ t: T.WOL_INFO, macs: ownMacs(), address: this.address() || '' });
    if (this.bus) {
      this.bus.onPeer('welcome', (id) => this.bus.send(id, info()));
      this.bus.on(T.WOL_INFO, (m, from) => { const s = this.peer(from); if (s) this._learn(from, s.name, s.os, m); });
    } else {
      this.link.on('welcome', () => this.link.send(info()));
      this.link.on(T.WOL_INFO, (m) => {
        const s = this.link.snapshot().session;
        if (s && s.id) this._learn(s.id, s.name, s.os, m);
      });
    }
    this.check();
  }

  // A device's wol.info: kept for it, saved only when it changed (it comes again on every connect).
  _learn(id, peerName, peerOs, m) {
    const macs = (Array.isArray(m.macs) ? m.macs : []).map((x) => String(x).toLowerCase()).filter((x) => MAC_RE.test(x)).slice(0, 8);
    if (!id || !macs.length) return;
    const address = typeof m.address === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(m.address) ? m.address : '';
    const name = String(peerName || '').slice(0, 200);
    const was = this.settings.wake.peers[id];
    if (was && was.name === name && was.os === peerOs && was.address === address && String(was.macs) === String(macs)) return;
    this.settings.wake.peers[id] = { name, os: peerOs, macs, address, at: Date.now() };
    this.save();
    this.onChange();
  }

  // Wake a paired computer. False when we never learned how.
  wake(id) {
    const p = this.settings.wake.peers[id];
    if (!p) return false;
    const sock = dgram.createSocket('udp4');
    sock.on('error', (e) => console.warn('[wake]', e.message));
    sock.bind(() => {
      sock.setBroadcast(true);
      const targets = new Set(['255.255.255.255', ...interfaces().map((i) => i.broadcast)]);
      if (p.address) targets.add(p.address);
      let n = 0;
      for (const mac of p.macs) {
        for (const host of targets) {
          for (const port of [9, 7]) {
            n++;
            sock.send(magic(mac), port, host, () => { if (--n === 0) sock.close(); });
          }
        }
      }
    });
    this.last = { id, at: Date.now() };
    console.log('[wake] magic packet for ' + p.name + ' (' + p.macs.join(', ') + ')');
    this.onChange();
    setTimeout(() => this.onChange(), 20000); // "Waking …" ends
    return true;
  }

  async check() {
    const list = adapters();
    this.state = { ...this.state, checked: true, adapters: list, on: list.length ? list.some((a) => a.armed) : null, error: '' };
    this.onChange();
  }

  async set(on) {
    if (this.state.busy) return;
    this.state = { ...this.state, busy: true, error: '' };
    this.onChange();
    const names = adapters().map((a) => a.name).filter((n) => /^[\w.-]+$/.test(n));
    try {
      if (!names.length) throw new Error('No wired network adapter is connected');
      await pkexec(names.map((n) => `(command -v ethtool >/dev/null && ethtool -s ${n} wol ${on ? 'g' : 'd'}); echo ${on ? 'enabled' : 'disabled'} > /sys/class/net/${n}/device/power/wakeup`).join('; '));
    } catch (e) {
      this.state.error = /cancel/i.test(e.message) ? 'The administrator prompt was declined' : e.message;
    }
    this.state.busy = false;
    await this.check();
  }

  view() {
    const peers = {};
    for (const [id, p] of Object.entries(this.settings.wake.peers)) peers[id] = { name: p.name, os: p.os, at: p.at };
    const waking = this.last && Date.now() - this.last.at < 20000 ? this.last.id : '';
    return { ...this.state, peers, waking };
  }
}

module.exports = Wake;
