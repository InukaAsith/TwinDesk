// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Each side sends `wol.info {macs, address}`
// after welcome; we keep it per paired device (settings.wake.peers) so Overview › Paired can wake a
// sleeping or switched-off computer with a magic packet (6 × 0xFF, then its MAC address 16 times) to
// every broadcast address and its last address, ports 9 and 7. The link keeps retrying by itself, so
// it connects as soon as the other computer is up. General shows whether this PC's network adapter
// may wake it, and its switch turns that on or off (one elevated PowerShell).
'use strict';

const dgram = require('dgram');
const os = require('os');
const P = require('../shared/protocol.js');
const { interfaces } = require('./discovery');
const { script, scriptElevated } = require('./ps');

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

// scripts/wake-check.ps1: up physical adapters, may each wake the PC (armed in powercfg) and on a
// magic packet. scripts/wake-set.ps1 is the switch, both ways (elevated).

class Wake {
  // opts: link, settings (shared, .wake), save(), onChange(), address() (the one the peer can reach)
  constructor(opts) {
    Object.assign(this, opts);
    this.state = { checked: false, on: null, busy: false, adapters: [], error: '' };
    this.last = null; // {id, at}: the last wake we sent

    this.link.on('welcome', () => {
      this.link.send({ t: T.WOL_INFO, macs: ownMacs(), address: this.address() || '' });
    });
    this.link.on(T.WOL_INFO, (m) => {
      const s = this.link.snapshot().session;
      const macs = (Array.isArray(m.macs) ? m.macs : []).map((x) => String(x).toLowerCase()).filter((x) => MAC_RE.test(x)).slice(0, 8);
      if (!s || !s.id || !macs.length) return;
      const address = typeof m.address === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(m.address) ? m.address : '';
      this.settings.wake.peers[s.id] = { name: String(s.name || '').slice(0, 200), os: s.os, macs, address, at: Date.now() };
      this.save();
      this.onChange();
    });
    this.check();
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
    try {
      const out = (await script('wake-check', {}, 30000)).trim();
      const list = out ? [].concat(JSON.parse(out)) : [];
      const adapters = list.map((a) => ({ name: String(a.name), armed: !!a.armed, magic: String(a.magic || '') }));
      // magic is '' when Windows wouldn't tell us without elevation: then armed alone decides.
      const ok = (a) => a.armed && (!a.magic || a.magic === 'Enabled');
      this.state = { ...this.state, checked: true, adapters, on: adapters.length ? adapters.some(ok) : null, error: '' };
    } catch (e) {
      this.state = { ...this.state, checked: true, on: null, error: e.message };
    }
    this.onChange();
  }

  async set(on) {
    if (this.state.busy) return;
    this.state = { ...this.state, busy: true, error: '' };
    this.onChange();
    try {
      await scriptElevated('wake-set', { On: !!on });
    } catch (e) {
      this.state.error = /cancel/i.test(e.message) ? 'Windows didn’t allow it' : e.message;
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
