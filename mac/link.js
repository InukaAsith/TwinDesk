// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Guest role: this Mac dials ONE computer it was paired from (a host). WSS client with certificate
// pinning, pairing as the initiator, hello, busy-aware liveness, reconnect. Port of
// windows/link.js; links.js (LinkManager) keeps one Link per host in hosts.json.
//
// Events (EventEmitter): 'welcome' (msg), 'closed' ({}), 'request' (a pairing code is ready).
// After `welcome`, messages go to onAny(msg) when it is set (session.js), else to 'message'.
// onState(fn) is called on every status or pairing change.
'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const T = P.T;
// A host without `os` is an older Mac.
const osOf = (o) => (Object.values(P.OS).includes(o) ? o : P.OS.MAC);
const KEEPALIVE_TICK_MS = 250; // how often the keep-alive decides whether to ping

const PAIR_ERRORS = {
  [P.E.PAIR_REFUSED]: 'Pairing was refused.',
  [P.E.PAIR_TIMEOUT]: 'Pairing timed out.',
  [P.E.BUSY]: 'That computer is busy with another device.',
  [P.E.VERSION_MISMATCH]: 'That computer runs a different TwinDesk version. Update both.',
};

class Link extends EventEmitter {
  // opts: device {id, name} (this Mac: id = macId); store {load() -> entry|null, save(entry), clear()};
  //   resolveAddress(macId) -> {address, port}|null; blocked() -> true while this link must not dial
  //   (mesh tie-break, inbound link present); busy() -> true while the link is busy (ping every
  //   PING_MS, else every IDLE_PING_MS; default: busy).
  constructor(opts) {
    super();
    this.device = opts.device;
    this.blocked = opts.blocked || (() => false);
    this.busy = opts.busy || (() => true);
    this.store = opts.store;
    this.resolveAddress = opts.resolveAddress || (() => null);
    this.pairing = this.store.load(); // {macId, macName, address, port, fp, token, os} or null
    this.pairState = null; // pairing in progress: {phase, address, port, macName, code, error}
    this.status = { state: this.pairing ? 'connecting' : 'not_paired', rtt: null, message: '' };
    this.ws = null;
    this.mode = null; // 'session' | 'pair'
    this.authed = false;
    this.destroyed = false;
    // Disconnect here, or the host let us go / another device took over: no reconnecting by itself
    // until connect(). {why: 'local' | released | replaced, message}
    this.stopped = null;
    this.takeover = false; // the next hello takes the session from whoever has it (Take over, an invite)
    this.busyBy = ''; // the host is in use by someone else: tried again now and then
    this.attempt = 0;
    this.timers = {};
    this.lastRx = 0;
    this.lastTx = 0;
    this.lastError = '';
    this.seenFp = '';
    this.onAny = null; // session.js: gets every message after welcome
    this.stateFns = [];
  }

  // ---- public API ----

  start() {
    if (this.pairing) this._connect('session');
  }

  onState(fn) {
    this.stateFns.push(fn);
  }

  send(obj) {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    this.lastTx = Date.now();
    return true;
  }

  // Bytes queued on the socket (file transfers wait while this is high).
  get bufferedAmount() {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  // {link, pairing, paired} for the UI (the shape hub.snapshot() uses).
  snapshot() {
    const p = this.pairing;
    return {
      link: { ...this.status, busy: this.authed ? '' : this.busyBy, macName: p ? p.macName : '', address: p ? p.address : '' },
      pairing: this.pairState ? { ...this.pairState } : null,
      paired: p ? { macId: p.macId, macName: p.macName, address: p.address, port: p.port, os: osOf(p.os) } : null,
    };
  }

  startPairing({ address, port, macName }) {
    clearTimeout(this.timers.reconnect);
    this.pairState = { phase: 'connecting', address, port: port || P.PORT, macName: macName || address, code: '', error: '' };
    this._connect('pair');
    this._changed();
  }

  confirmCode() {
    const ps = this.pairState;
    if (!ps || ps.phase !== 'code' || this.mode !== 'pair') return;
    this._raw({ t: T.PAIR_CONFIRM });
    ps.phase = 'waiting';
    this._changed();
  }

  cancelPair() {
    const ps = this.pairState;
    if (!ps) return;
    if (this.mode === 'pair' && ps.phase !== 'failed') this._raw({ t: T.PAIR_CANCEL });
    this.pairState = null;
    if (this.mode === 'pair') this._closeSocket();
    this._resume();
  }

  // Disconnect: stays away until Connect (or the host invites us).
  disconnect() {
    if (!this.pairing) return;
    this.stopped = { why: 'local', message: '' };
    clearTimeout(this.timers.reconnect);
    if (this.authed) this._raw({ t: T.BYE }); // on purpose: the host doesn't wait for us
    this._closeSocket();
    this._setStatus('stopped', '');
  }

  // Connect again, or Take over (takeover: the host's session with another device ends).
  connect(takeover = false) {
    if (!this.pairing || this.pairState) return;
    this.stopped = null;
    this.takeover = !!takeover;
    this.attempt = 0;
    this._connect('session');
  }

  forget() {
    this.stopped = null;
    clearTimeout(this.timers.reconnect);
    this._closeSocket();
    this.store.clear();
    this.pairing = null;
    this._setStatus('not_paired', '');
  }

  // The host dialled us (mesh): drop our own socket to it, so there is one link. Our link waits
  // until the inbound one ends (poke()).
  yieldSession() {
    if (!this.authed) return;
    this._closeSocket();
    this._scheduleReconnect();
  }

  // Stop for good: no socket, no reconnect (the manager closes its links this way).
  destroy() {
    this.destroyed = true;
    clearTimeout(this.timers.reconnect);
    this._closeSocket();
  }

  // Try again at once (the host went away and came back, or an inbound link ended).
  poke() {
    if (this.destroyed || !this.pairing || this.pairState || this.ws || this.stopped || this.status.state === 'identity_changed') return;
    this.attempt = 0;
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = setTimeout(() => !this.ws && !this.pairState && this._connect('session'), 300);
  }

  // ---- connection ----

  _connect(mode) {
    if (this.destroyed) return;
    this._closeSocket();
    clearTimeout(this.timers.reconnect);
    if (mode === 'session' && this.blocked()) return this._scheduleReconnect(); // mesh: wait our turn
    this.mode = mode;
    this.nw = this.nm = null;
    const target = mode === 'pair' ? this.pairState : this.pairing;
    const ws = new WebSocket(`wss://${target.address}:${target.port}`, {
      rejectUnauthorized: false, // self-signed; the fingerprint is pinned instead
      maxPayload: P.MAX_PAYLOAD,
      handshakeTimeout: 5000,
    });
    this.ws = ws;
    let seenFp = '';
    ws.on('upgrade', (res) => { seenFp = P.normFingerprint(res.socket.getPeerCertificate().fingerprint256); });
    ws.on('open', () => ws === this.ws && this._onOpen(seenFp));
    ws.on('message', (data, isBinary) => ws === this.ws && !isBinary && this._onMessage(String(data)));
    ws.on('error', (err) => { if (ws === this.ws) this.lastError = err.code || err.message; });
    ws.on('close', () => ws === this.ws && this._onClose());
  }

  _onOpen(seenFp) {
    this.seenFp = seenFp;
    this.lastRx = Date.now();
    this.lastError = '';
    if (this.mode === 'pair') {
      this.nw = P.randomHex(16);
      this._raw({ t: T.PAIR_START, v: P.PROTOCOL_VERSION, id: this.device.id, name: this.device.name, os: P.OS.MAC, commit: P.commitOf(this.nw) });
      this.pairState.phase = 'starting';
      return this._changed();
    }
    if (this.blocked()) { // another computer connected to us meanwhile
      this._closeSocket();
      return this._scheduleReconnect();
    }
    if (!seenFp || seenFp !== this.pairing.fp) {
      this._closeSocket();
      return this._setStatus('identity_changed', `${this.pairing.macName} looks different now. Forget it and pair again.`);
    }
    this._hello();
  }

  _hello() {
    const p = this.pairing;
    this._raw({ t: T.HELLO, v: P.PROTOCOL_VERSION, id: this.device.id, name: this.device.name, os: P.OS.MAC, token: p.token, mesh: 1, ...(this.takeover ? { takeover: true } : {}) });
    this.timers.hello = setTimeout(() => {
      this.lastError = 'No answer';
      if (this.ws) this.ws.terminate();
    }, P.TIMEOUT_MS);
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    this.lastRx = Date.now();
    switch (msg.t) {
      case T.PAIR_NONCE: return this._onNonce(msg);
      case T.PAIR_OK: return this._onPairOk(msg);
      case T.PAIR_CANCEL: return this._pairFailed('Pairing was cancelled on the other computer.');
      case T.WELCOME: return this._onWelcome(msg);
      case T.ERROR: return this._onError(msg);
      case T.PING: return this.authed && this._raw({ t: T.PONG, ts: msg.ts });
      case T.PONG:
        if (typeof msg.ts === 'number') this.status.rtt = Math.max(0, Date.now() - msg.ts);
        return this._changed();
    }
    if (!this.authed) return;
    if (this.onAny) return this.onAny(msg);
    this.emit('message', msg);
  }

  _onNonce(msg) {
    const ps = this.pairState;
    if (this.mode !== 'pair' || !ps || !this.nw || this.nm) return;
    if (typeof msg.nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(msg.nonce) || msg.nonce.length % 2) {
      return this._pairFailed('The other computer sent a bad pairing message.');
    }
    if (msg.os && msg.os !== P.OS.MAC) return this._pairFailed('That computer isn’t a Mac. Pair from TwinDesk on it instead.');
    this.nm = msg.nonce;
    this._raw({ t: T.PAIR_REVEAL, nonce: this.nw });
    ps.code = P.sasCode(this.seenFp, this.nw, this.nm);
    ps.phase = 'code';
    this._changed();
    this.emit('request');
  }

  _onPairOk(msg) {
    const ps = this.pairState;
    if (this.mode !== 'pair' || !ps || ps.phase !== 'waiting') return;
    if (typeof msg.token !== 'string' || !msg.token || typeof msg.macId !== 'string') {
      return this._pairFailed('The other computer sent a bad pairing message.');
    }
    this.pairing = {
      macId: msg.macId,
      macName: typeof msg.macName === 'string' && msg.macName ? msg.macName.slice(0, 64) : ps.macName,
      address: ps.address,
      port: ps.port,
      fp: this.seenFp,
      token: msg.token,
      os: osOf(msg.os),
    };
    this.store.save(this.pairing);
    this.pairState = null;
    this.mode = 'session';
    this._setStatus('connecting', '');
    this._hello();
  }

  _onWelcome(msg) {
    if (this.mode !== 'session' || this.authed) return;
    clearTimeout(this.timers.hello);
    this.authed = true;
    this.attempt = 0;
    const os = osOf(msg.os || this.pairing.os);
    if ((typeof msg.macName === 'string' && msg.macName && msg.macName !== this.pairing.macName) || os !== this.pairing.os) {
      if (typeof msg.macName === 'string' && msg.macName) this.pairing.macName = msg.macName.slice(0, 64);
      this.pairing.os = os;
      this.store.save(this.pairing);
    }
    this.status.rtt = null;
    this.lastTx = Date.now();
    this.timers.ping = setInterval(() => this._keepalive(), KEEPALIVE_TICK_MS);
    this.takeover = false;
    this.busyBy = '';
    this._setStatus('connected', '');
    this.emit('welcome', msg);
  }

  _onError(msg) {
    const code = msg.code;
    if (this.mode === 'pair') return this._pairFailed(PAIR_ERRORS[code] || `Pairing failed (${code}).`);
    if (code === P.E.BAD_TOKEN) {
      const name = this.pairing ? this.pairing.macName : 'the other computer';
      this.forget();
      this._setStatus('not_paired', `${name} forgot this Mac. Pair again.`);
      return;
    }
    if (code === P.E.REPLACED || code === P.E.RELEASED) {
      this.stopped = { why: code, message: String(msg.message || (code === P.E.RELEASED ? 'Disconnected' : 'Another device took over')).slice(0, 120) };
    } else if (code === P.E.BUSY) this.lastError = this.busyBy = String(msg.message || 'In use by another device').slice(0, 120);
    else this.lastError = `Closed (${code})`;
    // The host closes the socket after an error; _onClose reconnects.
  }

  _pairFailed(error) {
    const ps = this.pairState;
    if (!ps) return;
    Object.assign(ps, { phase: 'failed', error, code: '' });
    this._closeSocket();
    this._changed();
    this._resume();
  }

  _onClose() {
    const wasAuthed = this.authed;
    this._clearSocketTimers();
    this.ws = null;
    this.authed = false;
    if (wasAuthed) this._emit('closed', {});
    if (this.mode === 'pair') {
      const ps = this.pairState;
      if (ps && ps.phase !== 'failed') {
        this._pairFailed(ps.phase === 'connecting'
          ? `Couldn’t connect to ${ps.address}${this.lastError ? ` (${this.lastError})` : ''}.`
          : 'The connection closed.');
      }
      return;
    }
    if (this.stopped) return this._setStatus('stopped', this.stopped.message);
    if (this.pairing && this.status.state !== 'identity_changed') this._scheduleReconnect();
  }

  // Back to the stored pairing (if any) after a pairing attempt ended.
  _resume() {
    if (this.pairing) {
      this.attempt = 0;
      if (!this.ws || this.mode !== 'session') this._scheduleReconnect();
    } else {
      this._setStatus('not_paired', this.status.message);
    }
  }

  _scheduleReconnect(delayMs) {
    if (this.destroyed) return;
    clearTimeout(this.timers.reconnect);
    if (this.stopped) return this._setStatus('stopped', this.stopped.message);
    const delays = P.RECONNECT_MS;
    // In use by another device: now and then (and at once when the host says it's free: poke).
    const delay = delayMs !== undefined ? delayMs : this.busyBy ? 10000 : delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this._setStatus('reconnecting', this.lastError || '');
    this.timers.reconnect = setTimeout(() => {
      if (!this.pairing || this.pairState || this.destroyed) return;
      const seen = this.resolveAddress(this.pairing.macId);
      if (seen && (seen.address !== this.pairing.address || seen.port !== this.pairing.port)) {
        this.pairing.address = seen.address;
        this.pairing.port = seen.port;
        this.store.save(this.pairing);
      }
      this._connect('session');
    }, delay);
  }

  _closeSocket() {
    const ws = this.ws;
    this._clearSocketTimers();
    this.ws = null;
    const wasAuthed = this.authed;
    this.authed = false;
    if (wasAuthed) this._emit('closed', {});
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else ws.terminate();
  }

  _clearSocketTimers() {
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.hello);
  }

  _raw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      this.lastTx = Date.now();
    }
  }

  // Keep-alive: ping only when nothing was sent for the interval; a silent link is closed.
  _keepalive() {
    const now = Date.now();
    const busy = this.busy();
    if (now - this.lastRx > (busy ? P.TIMEOUT_MS : P.IDLE_TIMEOUT_MS)) {
      this.lastError = 'Stopped answering';
      if (this.ws) this.ws.terminate();
      return;
    }
    if (now - this.lastTx >= (busy ? P.PING_MS : P.IDLE_PING_MS)) this._raw({ t: T.PING, ts: now });
  }

  // Local events ('welcome', 'closed') go to the listeners of this EventEmitter.
  _emit(type, msg) {
    this.emit(type, msg);
  }

  _setStatus(state, message) {
    this.status = { state, message: message || '', rtt: state === 'connected' ? this.status.rtt : null };
    this._changed();
  }

  _changed() {
    for (const fn of this.stateFns) fn();
  }
}

module.exports = { Link };
