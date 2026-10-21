// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every two-way section is one setting shared by both
// computers, remembered per pair. "Show this PC's notifications on the Mac" is this PC's
// notifs.send AND the Mac's notifs.receive: flip it on either computer and the other follows.
// Directions are told from the sender's side ('out' = the sender's things on the receiver), so the
// receiver flips them. On connect each side restores its values for that peer; then the host sends
// all of them (`pair.sync {all}`) and the guest adopts them. Reference: mac/pairsync.js.
//
// Call check() with every state push (main.js): it sends what changed here.
'use strict';

const P = require('../shared/protocol.js');

const T = P.T;

// feature → settings [section, key] for this PC's out (mine → theirs) / in (theirs → mine).
const FEATURES = {
  clipboard: { out: ['clipboard', 'send'], in: ['clipboard', 'receive'] },
  notifs: { out: ['notifs', 'send'], in: ['notifs', 'receive'] },
  apps: { out: ['pcApps', 'allow'], in: ['macApps', 'on'] },
  audio: { out: ['audio', 'send'], in: ['audio', 'receive'] },
  cursor: { out: ['kvm', 'driveOther'], in: ['kvm', 'beDriven'] },
};
// Shared values, the same on both computers (no direction): key → settings path + values.
const VALUES = {
  pace: { path: ['monitor', 'pacing'], allowed: ['fast', 'smooth'] },
  gestures: { path: ['kvm', 'gestures'], allowed: [true, false] },
  ble: { path: ['kvm', 'ble'], allowed: [true, false] }, // cursor sharing over Bluetooth (kvm.js)
  // Set on either side for this PC's mouse and keyboard on a phone (its Cursor and Keyboard pages).
  keyboard: { path: ['kvm', 'keyboard'], allowed: [true, false], phone: true },
  speed: { path: ['kvm', 'speed'], allowed: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3], phone: true },
  reverseScroll: { path: ['kvm', 'reverseScroll'], allowed: [true, false], phone: true },
};

class PairSync {
  // opts: link, settings (shared; .pairSync is kept here), save(), set(section, partial) (ipc.js:
  // applies a setting with its side effects)
  constructor(opts) {
    Object.assign(this, opts);
    this.last = null; // the values both computers agree on now
    this.peerId = '';
    if (!this.settings.pairSync || typeof this.settings.pairSync !== 'object') this.settings.pairSync = {};

    this.link.on('welcome', () => {
      const s = this.link.snapshot().session;
      this.peerId = s && s.id ? String(s.id) : '';
      const saved = this.settings.pairSync[this.peerId];
      this.last = this.values();
      if (saved) this._adopt(saved);
      if (this.link.hosting) this.link.send({ t: T.PAIR_SYNC, all: this.last }); // we are the host: ours win
    });
    this.link.on('closed', () => { this.last = null; this.peerId = ''; });
    this.link.on(T.PAIR_SYNC, (m) => {
      if (!this.last) return;
      const vals = this._values();
      if (vals[m.key] && vals[m.key].allowed.includes(m.value)) return this._adopt({ values: { [m.key]: m.value } });
      if (m.all && typeof m.all === 'object') {
        const mine = { values: {} };
        for (const [k, d] of Object.entries(vals)) if (m.all.values && d.allowed.includes(m.all.values[k])) mine.values[k] = m.all.values[k];
        for (const f of Object.keys(FEATURES)) {
          const v = m.all[f];
          if (v && typeof v === 'object') mine[f] = { out: v.in, in: v.out }; // their in = our out
        }
        this._adopt(mine);
      } else if (FEATURES[m.feature] && (m.dir === 'out' || m.dir === 'in') && typeof m.on === 'boolean') {
        this._adopt({ [m.feature]: { [m.dir === 'out' ? 'in' : 'out']: m.on } });
      }
    });
  }

  // The shared values with this peer: the phone-only ones only with a phone.
  _values() {
    const phone = this.link.peerOs === P.OS.ANDROID;
    return Object.fromEntries(Object.entries(VALUES).filter(([, d]) => phone || !d.phone));
  }

  values() {
    const out = {};
    for (const [f, d] of Object.entries(FEATURES)) {
      out[f] = { out: !!this.settings[d.out[0]][d.out[1]], in: !!this.settings[d.in[0]][d.in[1]] };
    }
    out.values = {};
    for (const [k, d] of Object.entries(this._values())) out.values[k] = this.settings[d.path[0]][d.path[1]];
    return out;
  }

  // Take values from the peer (or our saved ones) without sending them back.
  _adopt(vals) {
    const now = this.values();
    const known = this._values();
    for (const [k, v] of Object.entries(vals.values || {})) {
      const d = known[k];
      if (!d || !d.allowed.includes(v) || now.values[k] === v) continue;
      now.values[k] = v;
      this.last = now;
      this.set(d.path[0], { [d.path[1]]: v });
    }
    for (const [f, v] of Object.entries(vals)) {
      if (f === 'values' || !FEATURES[f] || !v) continue;
      for (const dir of ['out', 'in']) {
        if (typeof v[dir] !== 'boolean' || now[f][dir] === v[dir]) continue;
        const [section, key] = FEATURES[f][dir];
        now[f][dir] = v[dir];
        this.last = now; // before set(): its state push must not echo this change
        this.set(section, { [key]: v[dir] });
      }
    }
    this.last = now;
    this._remember(now);
  }

  _remember(vals) {
    if (!this.peerId) return;
    this.settings.pairSync[this.peerId] = vals;
    this.save();
  }

  check() {
    if (!this.last || this.link.status.state !== 'connected') return;
    const now = this.values();
    let changed = false;
    for (const f of Object.keys(FEATURES)) {
      for (const dir of ['out', 'in']) {
        if (now[f][dir] === this.last[f][dir]) continue;
        changed = true;
        this.link.send({ t: T.PAIR_SYNC, feature: f, dir, on: now[f][dir] });
      }
    }
    for (const k of Object.keys(now.values)) {
      if (now.values[k] === (this.last.values || {})[k]) continue;
      changed = true;
      this.link.send({ t: T.PAIR_SYNC, key: k, value: now.values[k] });
    }
    this.last = now;
    if (changed) this._remember(now);
  }
}

module.exports = { PairSync, FEATURES, VALUES };
