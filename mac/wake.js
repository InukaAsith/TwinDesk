// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Wake the other computer over the network. Each side sends `wol.info {macs, address}`
// after welcome; we keep it per paired device (settings.wake.peers) and send a Wake-on-LAN magic
// packet (6 × 0xFF, then the MAC address 16 times) to every broadcast address and the last known
// address, ports 9 and 7. This Mac's own "Wake for network access" (pmset womp) is shown and can be
// switched on (asks for an administrator password).
//
// Events: 'change' — this.view changed.
'use strict';

const dgram = require('dgram');
const os = require('os');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { interfaces } = require('./discovery');

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

function ownMacs() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && MAC_RE.test(i.mac) && !/^0[02]:00:00:00:00:00$/.test(i.mac)) out.add(i.mac);
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

class Wake extends EventEmitter {
  // bus, peer(id) → {name, os, address}: Multi-device (the hub's bus): every device is told how to wake
  // this Mac when it connects, and learned from whichever device tells, not only the selected one (#313)
  constructor({ server, getSettings, saveSettings, bus = null, peer = null }) {
    super();
    Object.assign(this, { server, getSettings, saveSettings, bus, peer });
    this.womp = null; // this Mac: Wake for network access (null = unknown)
    this.last = null; // {id, at} the last wake we sent

    const info = () => {
      const all = interfaces();
      const addr = all.find((i) => /^en\d/.test(i.name)) || all[0];
      return { t: P.T.WOL_INFO, macs: ownMacs(), address: addr ? addr.address : '' };
    };
    if (bus) {
      bus.onPeer('welcome', (id) => bus.send(id, info()));
      bus.on(P.T.WOL_INFO, (m, from) => { const x = peer(from); if (x) this._learn(from, x, m); });
    } else {
      server.on('client', (ctx) => server.send(ctx, info()));
      server.on(`t:${P.T.WOL_INFO}`, (m, ctx) => ctx && this._learn(ctx.deviceId, ctx, m));
    }
    this.checkWomp();
  }

  // A device's wol.info: kept for it, saved only when it changed (it comes again on every connect).
  _learn(id, who, m) {
    const macs = (Array.isArray(m.macs) ? m.macs : []).map((x) => String(x).toLowerCase()).filter((x) => MAC_RE.test(x)).slice(0, 8);
    if (!id || !macs.length) return;
    const name = String(who.name || '').slice(0, 200);
    const address = String(m.address || who.address || '').slice(0, 64);
    const was = this.peers[id];
    if (was && was.name === name && was.os === who.os && was.address === address && String(was.macs) === String(macs)) return;
    this.peers[id] = { name, os: who.os, macs, address, at: Date.now() };
    this.saveSettings();
    this.emit('change');
  }

  get peers() {
    const w = this.getSettings().wake;
    if (!w.peers) w.peers = {};
    return w.peers;
  }

  // Wake a paired device that is asleep or off. Returns false when we never learned its address.
  wake(id) {
    const p = this.peers[id];
    if (!p) return false;
    const sock = dgram.createSocket('udp4');
    sock.on('error', (e) => console.log(`[wake] ${e.message}`));
    sock.bind(() => {
      sock.setBroadcast(true);
      const targets = new Set(['255.255.255.255', ...interfaces().map((i) => i.broadcast)]);
      if (p.address) targets.add(p.address);
      let n = 0;
      for (const mac of p.macs) {
        for (const host of targets) {
          for (const port of [9, 7]) {
            n++;
            sock.send(magic(mac), port, host, () => --n === 0 && sock.close());
          }
        }
      }
    });
    this.last = { id, at: Date.now() };
    console.log(`[wake] magic packet for ${p.name} (${p.macs.join(', ')})`);
    this.emit('change');
    return true;
  }

  checkWomp() {
    execFile('/usr/bin/pmset', ['-g'], (err, out) => {
      const m = !err && /\bwomp\s+(\d)/.exec(out);
      this.womp = m ? m[1] === '1' : null;
      this.emit('change');
    });
  }

  // "Wake for network access" on/off (all power sources). macOS asks for an administrator password.
  setWomp(on) {
    const script = `do shell script "/usr/bin/pmset -a womp ${on ? 1 : 0}" with administrator privileges`;
    execFile('/usr/bin/osascript', ['-e', script], () => this.checkWomp());
  }

  get view() {
    const peers = {};
    for (const [id, p] of Object.entries(this.peers)) peers[id] = { name: p.name, os: p.os, at: p.at };
    return { womp: this.womp, peers, last: this.last };
  }
}

module.exports = { Wake };
