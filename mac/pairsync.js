// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every two-way section is one setting shared by both computers, remembered per pair.
// "Show this Mac's notifications on PC" is this Mac's notifs.send AND the PC's notifs.receive:
// flip it on either computer and the other follows (`pair.sync`). Directions are told from the
// sender's side ('out' = the sender's things shown on / used by the receiver), so the receiver
// flips them. On connect each side restores its values for that peer; then the host sends all of
// them (`pair.sync {all}`) and the guest adopts them, so both agree.
//
// A feature may have one direction only (Remote: the phone's Remote page moving this Mac; the phone
// has no switch of its own, its page sends `pair.sync` to turn it on here; Files: the Mac has no
// switch for sending). ReZume's own switch is a shared value, its directions the two ways under it.
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
  rezume: { out: ['rezume', 'send'], in: ['rezume', 'receive'] },
  remote: { in: ['remote', 'allow'] },
  terminal: { out: ['terminal', 'allowPc'], in: ['terminal', 'connectPc'] },
  files: { in: ['files', 'acceptDrops'] },
};
// Shared values, the same on both computers (no direction): key -> settings path + allowed values.
const VALUES = {
  rezume: { path: ['rezume', 'on'], allowed: [true, false], feature: 'rezume' }, // only where the app has ReZume
  pace: { path: ['sharing', 'pace'], allowed: ['fast', 'smooth', 'steady'] },
  gestures: { path: ['kvm', 'gestures'], allowed: [true, false] },
  syncPads: { path: ['kvm', 'syncPads'], allowed: [true, false] }, // one pointer for every mouse (kvm.js 'local')
  ble: { path: ['kvm', 'ble'], allowed: [true, false] }, // cursor sharing over Bluetooth (kvm.js)
  // Share Keyboard: one switch for both sides (a computer, or a phone's Keyboard page). Set on
  // either side for the speed and scrolling of this computer's mouse on a phone (its Cursor page).
  keyboard: { path: ['kvm', 'keyboard'], allowed: [true, false] },
  speed: { path: ['kvm', 'speed'], allowed: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4], phone: true },
  reverseScroll: { path: ['kvm', 'reverseScroll'], allowed: [true, false], phone: true },
};

class PairSync {
  // only: the features this app has (else all of them)
  constructor({ server, getSettings, saveSettings, apply, only }) {
    Object.assign(this, { server, getSettings, saveSettings, apply });
    this.features = Object.fromEntries(Object.entries(FEATURES).filter(([f]) => !only || only.includes(f)));
    this.last = null; // values as both sides agree on them now
    this.peerId = null;

    server.on('client', (ctx) => {
      this.peerId = ctx.deviceId;
      const saved = this._byPeer()[ctx.deviceId];
      if (saved) this._adopt(this._restorable(saved));
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
        for (const f of Object.keys(this.features)) {
          const v = m.all[f];
          if (v && typeof v === 'object') mine[f] = { out: v.in, in: v.out }; // their in = our out (what they don't have stays)
        }
        this._adopt(mine);
      } else if (this.features[m.feature] && (m.dir === 'out' || m.dir === 'in')) {
        this._adopt({ [m.feature]: { [m.dir === 'out' ? 'in' : 'out']: !!m.on } });
      }
    });
  }

  _byPeer() {
    const s = this.getSettings();
    if (!s.pairSync) s.pairSync = {};
    return s.pairSync;
  }

  // ReZume isn't restored per pair: its settings stay as they are, and the host's win on connect, so
  // turning it on while not connected holds. An entry from before its switch was shared may have
  // both ways stuck off (turning it off on the other side did that): they come back on, once.
  _restorable(saved) {
    const { rezume, ...rest } = saved;
    if (rest.values) {
      const { rezume: on, ...values } = rest.values;
      rest.values = values;
      if (on !== undefined) return rest;
    }
    const r = this.getSettings().rezume;
    if (this.features.rezume && r && !r.send && !r.receive) {
      this.apply('rezume', 'out', true);
      this.apply('rezume', 'in', true);
    }
    return rest;
  }

  // The shared values with this peer: the phone-only ones only with a phone.
  _values() {
    const c = this.server.current;
    const phone = !!c && c.os === P.OS.ANDROID;
    return Object.fromEntries(Object.entries(VALUES).filter(([, d]) => (phone || !d.phone) && (!d.feature || this.features[d.feature])));
  }

  // A direction's value: undefined where this side has no such switch.
  _get(s, d, dir) {
    const p = d[dir];
    const sec = p && s[p[0]];
    if (!sec || typeof sec !== 'object') return undefined;
    return !!sec[p[1]];
  }

  values() {
    const s = this.getSettings();
    const out = {};
    for (const [f, d] of Object.entries(this.features)) out[f] = { out: this._get(s, d, 'out'), in: this._get(s, d, 'in') };
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
      const d = this.features[f];
      if (f === 'values' || !d || !v) continue;
      for (const dir of ['out', 'in']) {
        if (typeof v[dir] !== 'boolean' || typeof now[f][dir] !== 'boolean' || now[f][dir] === v[dir]) continue;
        const [g, k] = d[dir];
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
    for (const f of Object.keys(this.features)) {
      for (const dir of ['out', 'in']) {
        if (typeof now[f][dir] !== 'boolean' || now[f][dir] === (this.last[f] || {})[dir]) continue;
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
