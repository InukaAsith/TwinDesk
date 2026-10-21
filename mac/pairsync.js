// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every two-way section is one setting shared by both computers, remembered per pair.
// "Show this Mac's notifications on PC" is this Mac's notifs.send AND the PC's notifs.receive:
// flip it on either computer and the other follows (`pair.sync`). Directions are told from the
// sender's side ('out' = the sender's things shown on / used by the receiver), so the receiver
// flips them. On connect each side restores its values for that peer; then the host sends all of
// them (`pair.sync {all}`) and the guest adopts them, so both agree.
//
// Call check() after any settings change (main's pushState does): it sends what changed.
'use strict';

const P = require('../shared/protocol.js');

// feature -> settings paths for this Mac's out / in direction.
const FEATURES = {
  clipboard: { out: ['clipboard', 'send'], in: ['clipboard', 'receive'] },
  notifs: { out: ['notifs', 'send'], in: ['notifs', 'receive'] },
  apps: { out: ['apps', 'offer'], in: ['papps', 'on'] },
  audio: { out: ['audio', 'send'], in: ['audio', 'receive'] },
  cursor: { out: ['kvm', 'driveOther'], in: ['kvm', 'beDriven'] },
};
// Shared values, the same on both computers (no direction): key -> settings path + allowed values.
const VALUES = {
  pace: { path: ['sharing', 'pace'], allowed: ['fast', 'smooth'] },
  gestures: { path: ['kvm', 'gestures'], allowed: [true, false] },
  ble: { path: ['kvm', 'ble'], allowed: [true, false] }, // cursor sharing over Bluetooth (kvm.js)
  // Set on either side for this Mac's mouse and keyboard on a phone (its Cursor and Keyboard
  // pages); only with a phone.
  keyboard: { path: ['kvm', 'keyboard'], allowed: [true, false], phone: true },
  speed: { path: ['kvm', 'speed'], allowed: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4], phone: true },
  reverseScroll: { path: ['kvm', 'reverseScroll'], allowed: [true, false], phone: true },
};

class PairSync {
  constructor({ server, getSettings, saveSettings, apply }) {
    Object.assign(this, { server, getSettings, saveSettings, apply });
    this.last = null; // values as both sides agree on them now
    this.peerId = null;

    server.on('client', (ctx) => {
      this.peerId = ctx.deviceId;
      const saved = this._byPeer()[ctx.deviceId];
      if (saved) this._adopt(saved);
      this.last = this.values();
      if (ctx.role !== 'host') server.send(ctx, { t: P.T.PAIR_SYNC, all: this.last }); // we are the host
    });
    server.on('closed', () => {
      if (!server.current) this.peerId = null;
    });
    server.on(`t:${P.T.PAIR_SYNC}`, (m) => {
      const vals = this._values();
      if (vals[m.key] && vals[m.key].allowed.includes(m.value)) return this._adopt({ values: { [m.key]: m.value } });
      if (m.all && typeof m.all === 'object') {
        const mine = { values: {} };
        for (const [k, d] of Object.entries(vals)) if (m.all.values && d.allowed.includes(m.all.values[k])) mine.values[k] = m.all.values[k];
        for (const f of Object.keys(FEATURES)) {
          const v = m.all[f];
          if (v && typeof v === 'object') mine[f] = { out: !!v.in, in: !!v.out }; // their in = our out
        }
        this._adopt(mine);
      } else if (FEATURES[m.feature] && (m.dir === 'out' || m.dir === 'in')) {
        this._adopt({ [m.feature]: { [m.dir === 'out' ? 'in' : 'out']: !!m.on } });
      }
    });
  }

  _byPeer() {
    const s = this.getSettings();
    if (!s.pairSync) s.pairSync = {};
    return s.pairSync;
  }

  // The shared values with this peer: the phone-only ones only with a phone.
  _values() {
    const c = this.server.current;
    const phone = !!c && c.os === P.OS.ANDROID;
    return Object.fromEntries(Object.entries(VALUES).filter(([, d]) => phone || !d.phone));
  }

  values() {
    const s = this.getSettings();
    const out = {};
    for (const [f, d] of Object.entries(FEATURES)) out[f] = { out: !!s[d.out[0]][d.out[1]], in: !!s[d.in[0]][d.in[1]] };
    out.values = {};
    for (const [k, d] of Object.entries(this._values())) out.values[k] = s[d.path[0]][d.path[1]];
    return out;
  }

  // Take values from the peer (or our saved ones) without sending them back.
  _adopt(vals) {
    const s = this.getSettings();
    const now = this.values();
    const known = this._values();
    for (const [k, v] of Object.entries(vals.values || {})) {
      const d = known[k];
      if (!d || now.values[k] === v) continue;
      s[d.path[0]][d.path[1]] = v;
      now.values[k] = v;
      this.apply('value', k, v);
    }
    for (const [f, v] of Object.entries(vals)) {
      if (f === 'values' || !FEATURES[f] || !v) continue;
      for (const dir of ['out', 'in']) {
        if (typeof v[dir] !== 'boolean' || now[f][dir] === v[dir]) continue;
        const [g, k] = FEATURES[f][dir];
        s[g][k] = v[dir];
        now[f][dir] = v[dir];
        this.apply(f, dir, v[dir]);
      }
    }
    this.last = now;
    this._remember(now);
  }

  _remember(vals) {
    if (!this.peerId) return;
    this._byPeer()[this.peerId] = vals;
    this.saveSettings();
  }

  check() {
    if (!this.server.current || !this.last) return;
    const now = this.values();
    let changed = false;
    for (const f of Object.keys(FEATURES)) {
      for (const dir of ['out', 'in']) {
        if (now[f][dir] === this.last[f][dir]) continue;
        changed = true;
        this.server.sendToClient({ t: P.T.PAIR_SYNC, feature: f, dir, on: now[f][dir] });
      }
    }
    for (const k of Object.keys(now.values)) {
      if (now.values[k] === (this.last.values || {})[k]) continue;
      changed = true;
      this.server.sendToClient({ t: P.T.PAIR_SYNC, key: k, value: now.values[k] });
    }
    this.last = now;
    if (changed) this._remember(now);
  }
}

module.exports = { PairSync, FEATURES };
