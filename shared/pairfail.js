// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Failed pairing attempts per address (hostpair.js): after too many, the host refuses new
// pair.starts from that address for a while, so an attacker on the network can't keep asking.
'use strict';

const MAX = 5;
const WINDOW_MS = 10 * 60 * 1000;

class PairFails {
  constructor() { this.map = new Map(); } // address -> [timestamps within the window]

  fail(address) {
    // 127.0.0.1 is our own Bluetooth/wired pipe, not an attacker on the network.
    if (!address || address === '127.0.0.1') return;
    this.map.set(address, this._live(address, Date.now()).concat(Date.now()));
  }

  locked(address) {
    const list = this._live(address, Date.now());
    if (!list.length) this.map.delete(address);
    return list.length >= MAX;
  }

  clear(address) { this.map.delete(address); }

  _live(address, now) {
    return (this.map.get(address) || []).filter((t) => now - t < WINDOW_MS);
  }
}

module.exports = { PairFails, MAX, WINDOW_MS };
