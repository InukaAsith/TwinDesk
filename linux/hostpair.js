// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Host role: pairing responder (numeric comparison),
// paired.json (the computers that connect to this PC), and `hello` auth. Port of mac/pairing.js.
//
// Events: 'change' — the pending request or the paired list changed;
//         'request' — a new code is ready to show (bring the window to the front).
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const store = require('./store');

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

class Pairing extends EventEmitter {
  // identity: {id, name, fp}; busy() -> true while this computer is a guest of another computer;
  // yieldTo() ends that guest session when a phone takes the session over.
  constructor(server, identity, { busy = () => false, yieldTo = () => {} } = {}) {
    super();
    this.busy = busy;
    this.yieldTo = yieldTo;
    this.server = server;
    this.id = identity;
    this.paired = store.read('paired.json', []);
    this.pending = null; // {ctx, id, name, commit, nm, nw, code, confirmed, allowed, timer}
    server.on('preauth', (ctx, msg) => this._onMessage(ctx, msg));
    server.on('closed', (ctx) => this._onClosed(ctx));
  }

  list() {
    return this.paired.map(({ id, name, os, pairedAt, lastSeen }) => ({ id, name, os: os || P.OS.WIN, pairedAt, lastSeen }));
  }

  // What the control window shows about an in-progress request.
  pendingView() {
    const p = this.pending;
    return p && { name: p.name, os: p.os, code: p.code, confirmed: p.confirmed, allowed: p.allowed, wired: p.wired };
  }

  touch(id) {
    const e = this.paired.find((x) => x.id === id);
    if (!e) return;
    e.lastSeen = Date.now();
    this._save();
  }

  forget(id) {
    this.paired = this.paired.filter((x) => x.id !== id);
    this._save();
    this.server.closeDevice(id, P.E.BAD_TOKEN, 'This computer forgot the pairing');
    this.emit('change');
  }

  // Local Allow / Deny.
  respond(allow) {
    const p = this.pending;
    if (!p) return;
    if (!allow) return this._abort(P.E.PAIR_REFUSED, 'Pairing was denied on the other computer');
    if (!p.code) return; // nothing to compare yet
    p.allowed = true;
    this.emit('change');
    this._maybeFinish();
  }

  _save() {
    store.write('paired.json', this.paired);
  }

  _onMessage(ctx, msg) {
    if (msg.t === P.T.HELLO) return this._hello(ctx, msg);

    const p = this.pending;
    if (msg.t === P.T.PAIR_START) {
      if (this.busy()) return this.server.fail(ctx, P.E.BUSY, 'Connected to another device');
      if (p && p.ctx !== ctx) return this.server.fail(ctx, P.E.BUSY, 'Another pairing is in progress');
      if (p) return this.server.fail(ctx, P.E.BAD_MESSAGE, 'Pairing already started');
      if (msg.v !== P.PROTOCOL_VERSION) {
        return this.server.fail(ctx, P.E.VERSION_MISMATCH, `This computer speaks protocol v${P.PROTOCOL_VERSION}`);
      }
      if (typeof msg.id !== 'string' || !msg.id || typeof msg.commit !== 'string' || !HEX(64).test(msg.commit)) {
        return this.server.fail(ctx, P.E.BAD_MESSAGE, 'pair.start needs id and commit');
      }
      const nm = P.randomHex(16);
      this.pending = {
        ctx,
        id: msg.id,
        name: String(msg.name || 'PC').slice(0, 64),
        os: Object.values(P.OS).includes(msg.os) ? msg.os : P.OS.WIN,
        commit: msg.commit,
        nm,
        nw: null,
        code: null,
        confirmed: false,
        allowed: false,
        // A phone on the USB cable, with the nonce wired.js sent it through adb (wired.knows):
        // no code to compare, only Allow here.
        wired: !!(this.isWired && this.isWired(msg.wired)),
        timer: setTimeout(() => this._abort(P.E.PAIR_TIMEOUT, 'Pairing timed out'), P.PAIR_TIMEOUT_MS),
      };
      this.server.send(ctx, { t: P.T.PAIR_NONCE, nonce: nm, os: P.OS.LINUX });
      return this.emit('change');
    }

    if (!p || p.ctx !== ctx) {
      if (msg.t === P.T.PAIR_CANCEL) return ctx.ws.close();
      return this.server.fail(ctx, P.E.BAD_MESSAGE, `"${msg.t}" without pair.start`);
    }

    switch (msg.t) {
      case P.T.PAIR_REVEAL:
        if (p.nw || typeof msg.nonce !== 'string' || !HEX(32).test(msg.nonce) || P.commitOf(msg.nonce) !== p.commit) {
          return this._abort(P.E.PAIR_REFUSED, 'Nonce does not match the commitment');
        }
        p.nw = msg.nonce;
        p.code = P.sasCode(this.id.fp, p.nw, p.nm);
        this.emit('change');
        this.emit('request');
        return;
      case P.T.PAIR_CONFIRM:
        if (!p.code) return this._abort(P.E.BAD_MESSAGE, 'pair.confirm before pair.reveal');
        p.confirmed = true;
        this.emit('change');
        return this._maybeFinish();
      case P.T.PAIR_CANCEL:
        this._clear();
        ctx.ws.close();
        return;
      default:
        return this._abort(P.E.BAD_MESSAGE, `Unexpected "${msg.t}" during pairing`);
    }
  }

  _maybeFinish() {
    const p = this.pending;
    if (!p || !p.confirmed || !p.allowed) return;
    const token = P.randomHex(32);
    const now = Date.now();
    this.paired = this.paired.filter((x) => x.id !== p.id);
    this.paired.push({ id: p.id, name: p.name, os: p.os, tokenHash: P.sha256Hex(token), pairedAt: now, lastSeen: now });
    this._save();
    this.server.send(p.ctx, { t: P.T.PAIR_OK, token, macId: this.id.id, macName: this.id.name, os: P.OS.LINUX });
    console.log(`[pairing] paired with ${p.name} (${p.id})`);
    this._clear();
  }

  _hello(ctx, msg) {
    if (msg.v !== P.PROTOCOL_VERSION) {
      return this.server.fail(ctx, P.E.VERSION_MISMATCH, `This computer speaks protocol v${P.PROTOCOL_VERSION}`);
    }
    const e = this.paired.find((x) => x.id === msg.id);
    if (!e || !P.tokenMatches(msg.token, e.tokenHash)) {
      return this.server.fail(ctx, P.E.BAD_TOKEN, 'Not paired with this computer');
    }
    // A phone only says hello when someone asked for it (or to resume): it takes the session.
    // A computer waits while a phone holds it.
    const phone = (Object.values(P.OS).includes(msg.os) ? msg.os : e.os) === P.OS.ANDROID;
    // Take over (the person asked for it there, or here: Connect on it in this computer's list):
    // whoever holds the session is let go. Else a computer waits while another device holds it.
    const takeover = msg.takeover === true || (this.expected && this.expected.id === e.id && Date.now() < this.expected.until);
    const held = this.server.current && this.server.current.authed && this.server.current.deviceId !== e.id ? this.server.current : null;
    if (phone || takeover) {
      this.expected = null;
      if (this.busy()) this.yieldTo();
      if (this.server.phoneGrace && this.server.phoneGrace.id !== e.id) this.server.endPhoneGrace();
    } else if (this.server.phoneHolds()) {
      return this.server.fail(ctx, P.E.BUSY, `In use by ${this._phoneName()}`);
    } else if (this.busy()) return this.server.fail(ctx, P.E.BUSY, 'Connected to another device');
    else if (held) return this.server.fail(ctx, P.E.BUSY, `In use by ${held.name || 'another device'}`);
    if (typeof msg.name === 'string' && msg.name && msg.name !== e.name) e.name = msg.name.slice(0, 64);
    if (Object.values(P.OS).includes(msg.os)) e.os = msg.os;
    e.lastSeen = Date.now();
    this._save();
    this.server.authenticate(ctx, { deviceId: e.id, name: e.name, os: e.os || P.OS.WIN }, {
      t: P.T.WELCOME, v: P.PROTOCOL_VERSION, macId: this.id.id, macName: this.id.name, os: P.OS.LINUX,
    });
    this.emit('change');
  }

  // Connect on a paired computer in this one's list: its next hello (it was invited) takes over.
  expect(id) {
    this.expected = { id, until: Date.now() + 60000 };
  }

  _phoneName() {
    const c = this.server.current;
    const id = c ? c.deviceId : this.server.phoneGrace && this.server.phoneGrace.id;
    const e = this.paired.find((x) => x.id === id);
    return (c && c.name) || (e && e.name) || 'phone';
  }

  _abort(code, message) {
    const p = this.pending;
    if (!p) return;
    this._clear();
    this.server.fail(p.ctx, code, message);
  }

  _clear() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
    this.emit('change');
  }

  _onClosed(ctx) {
    if (this.pending && this.pending.ctx === ctx) this._clear();
    if (ctx.authed && ctx.deviceId) this.touch(ctx.deviceId);
    this.emit('change');
  }
}

module.exports = { Pairing };
