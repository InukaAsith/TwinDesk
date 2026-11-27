// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What a link that moves between devices needs, step 5 of docs/mesh-graph.md: the links that follow the
// selection or their own rule (hub.sticky: Monitor 2, Move windows, the camera; hub.route: the
// microphone, the Mac's viewer, its apps, its phone) keep this themselves. It replaced shared/peerstate.js,
// one store of every device's policies and states in the hub, played into the facade on every crossing.
//
//   new LinkMemory(bus, types)   the last message of each of `types` from every device (the bus hears
//     them all), so a link that moves to a device tells its features what that one said meanwhile
//     (Monitor 2: whether it shares its screen; the microphone: whether it takes ours)
//     replay(id)                 copies, without `ask` (an ask is answered when it comes, not again)
//   new Goodbyes()               the policies a link turned on at its device, switched off there when the
//     link leaves it for another: any `*.policy` sent with `accept: true` or `share: true`
//     note(id, msg) / take(id) → the messages to send / forget(id) (its device went: nothing to switch off)
'use strict';

class LinkMemory {
  constructor(bus, types = []) {
    this.by = new Map(); // id -> Map(type -> msg)
    for (const t of types) {
      bus.on(t, (m, from) => {
        if (!from || !m) return;
        if (!this.by.has(from)) this.by.set(from, new Map());
        this.by.get(from).set(t, m);
      });
    }
    bus.onPeer('closed', (id) => this.by.delete(id)); // its next session says it all again
  }

  replay(id) {
    const m = id && this.by.get(id);
    if (!m) return [];
    return [...m.values()].map((x) => {
      const c = { ...x };
      delete c.ask;
      return c;
    });
  }
}

// The field of a policy that says it's on: accept (audio, mic, screen, papp) or share (cam).
const fieldOf = (msg) => (/\.policy$/.test(msg.t) ? ('accept' in msg ? 'accept' : 'share' in msg ? 'share' : null) : null);

class Goodbyes {
  constructor() {
    this.id = null;
    this.on = new Map(); // type -> field, while we told it the policy is on
  }

  note(id, msg) {
    if (!id || !msg || typeof msg.t !== 'string') return;
    const field = fieldOf(msg);
    if (!field) return;
    if (id !== this.id) {
      this.id = id;
      this.on.clear();
    }
    if (msg[field] === true) this.on.set(msg.t, field);
    else this.on.delete(msg.t);
  }

  take(id) {
    if (!id || id !== this.id) return [];
    const out = [...this.on].map(([t, field]) => ({ t, [field]: false }));
    this.on.clear();
    this.id = null;
    return out;
  }

  forget(id) {
    if (id && id === this.id) {
      this.on.clear();
      this.id = null;
    }
  }
}

module.exports = { LinkMemory, Goodbyes };
