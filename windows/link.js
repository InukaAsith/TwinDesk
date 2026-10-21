// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// WSS client to the Mac: certificate pinning, pairing, hello, liveness, reconnect.
// After `welcome`, messages are delivered by type through on(type, fn).
// A host that isn't on this network but is near goes through Bluetooth (opts.ble, blepipe.js): the
// same WSS over a 127.0.0.1 pipe. Once discovery sees the host on the network, a second socket
// takes the session over (hello {resume}); the Bluetooth one stays as the fallback (alt).
const WebSocket = require('ws');
const P = require('../shared/protocol.js');

const T = P.T;
// A host without `os` is an older Mac.
const osOf = (o) => (Object.values(P.OS).includes(o) ? o : P.OS.MAC);
const HELLO_TIMEOUT_MS = P.TIMEOUT_MS; // no `welcome` this long after hello = retry
const KEEPALIVE_TICK_MS = 250; // how often the keep-alive decides whether to ping
const RESUME_RETRY_MS = 5000; // a failed move to the network: try again after this
const isBle = (a) => String(a || '').startsWith('ble:');

const PAIR_ERRORS = {
  [P.E.PAIR_REFUSED]: '{Name} refused pairing.',
  [P.E.PAIR_TIMEOUT]: 'Pairing timed out.',
  [P.E.BUSY]: '{Name} is already pairing with another device.',
  [P.E.VERSION_MISMATCH]: '{Name} runs a different TwinDesk version. Update both apps.',
};

class Link {
  // opts: device {id, name}, store {load, save, clear}, resolveAddress(macId) -> {address, port}|null,
  //   blocked() -> true while this link must not dial (the manager's tie-break and inbound links),
  //   busy() -> true while the link is busy (ping every PING_MS, else every IDLE_PING_MS; default: busy),
  //   ble: BleGuest | null (blepipe.js)
  constructor(opts) {
    this.device = opts.device;
    this.blocked = opts.blocked || (() => false);
    this.busy = opts.busy || (() => true);
    this.destroyed = false;
    this.lastTx = 0;
    this.onAny = null; // peer.js: gets every message after welcome instead of the per-type handlers
    this.store = opts.store;
    this.resolveAddress = opts.resolveAddress;
    this.ble = opts.ble || null;
    this.transport = 'ip'; // the session's socket: 'ip' | 'ble'
    this.alt = null; // its other socket after a move (the fallback)
    this.pending = null; // a socket moving the session (hello {resume})
    this.resumeKey = '';
    this.seq = 0; // connection attempts: a Bluetooth pipe that opens late is dropped
    this.pairing = this.store.load(); // {macId, macName, address, port, fp, token} or null
    this.pairState = null; // pairing in progress: {phase, address, port, macName, code, error}
    this.status = { state: this.pairing ? 'connecting' : 'not_paired', rtt: null, message: '' };
    this.ws = null;
    this.mode = null; // 'session' | 'pair'
    this.authed = false;
    this.attempt = 0;
    // Disconnect here, or the host let us go / another device took over: no reconnecting by itself
    // until connect(). {why: 'local' | released | replaced, message}
    this.stopped = null;
    this.takeover = false; // the next hello takes the session from whoever has it (Take over, an invite)
    this.busyBy = ''; // the host is in use by someone else ("In use by …"): tried again now and then
    this.timers = {};
    this.handlers = new Map();
    this.stateFns = [];
    this.unknown = new Set();
  }

  // ---- public API ----

  start() {
    if (this.pairing) this._connect('session');
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  onState(fn) {
    this.stateFns.push(fn);
  }

  send(obj) {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    this.lastTx = this.ws.lastTx = Date.now();
    return true;
  }

  // Bytes queued on the socket (file transfers wait while this is high).
  get bufferedAmount() {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  snapshot() {
    const p = this.pairing;
    return {
      link: { ...this.status, busy: this.authed ? '' : this.busyBy, macName: p ? p.macName : '', address: p ? p.address : '', transport: this.authed ? this.transport : '' },
      pairing: this.pairState ? { ...this.pairState } : null,
      paired: p ? { macId: p.macId, macName: p.macName, address: p.address, port: p.port, os: osOf(p.os) } : null,
    };
  }

  // id: the host's, for one seen over Bluetooth (address 'ble:…').
  startPairing({ address, port, macName, id }) {
    clearTimeout(this.timers.reconnect);
    this.pairState = { phase: 'connecting', address, port: port || P.PORT, macName: macName || address, id: id || '', code: '', error: '' };
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

  // A phone took the session (hostpair.js): drop the computer we're a guest of. Reconnecting
  // waits while blocked(); poke() tries again at once when the phone lets go.
  yieldSession() {
    if (!this.authed) return;
    this._closeSocket();
    this._scheduleReconnect();
  }

  // Stop for good: no socket, no reconnect (the mesh manager closes its links this way).
  destroy() {
    this.destroyed = true;
    clearTimeout(this.timers.reconnect);
    this._closeSocket();
  }

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
    if (mode === 'session' && this.blocked()) return this._scheduleReconnect(); // hosting: try again later
    this.mode = mode;
    this.nw = this.nm = null;
    const target = mode === 'pair' ? this.pairState : this.pairing;
    const seq = ++this.seq;
    // Bluetooth: a host met there (pairing), or a paired one that isn't on the network but is near.
    const hostId = mode === 'pair' ? target.id : target.macId;
    const near = this.ble && hostId && this.ble.get(hostId);
    const viaBle = isBle(target.address) || (mode === 'session' && near && !this.resolveAddress(hostId));
    if (!viaBle) return this._open(target.address, target.port, 'ip');
    if (!near) {
      this.lastError = '{Name} isn’t nearby';
      return mode === 'pair' ? this._pairFailed('{Name} isn’t nearby any more.') : this._scheduleReconnect();
    }
    this.ws = { readyState: WebSocket.CONNECTING, terminate: () => {}, close: () => {}, bufferedAmount: 0 }; // opening the pipe
    this.ble.open(hostId).then((port) => {
      if (seq === this.seq) this._open('127.0.0.1', port, 'ble');
    }, (e) => {
      if (seq !== this.seq) return;
      this.lastError = e.message;
      this._onClose();
    });
  }

  _open(address, port, transport) {
    const ws = this._socket(address, port, transport);
    this.ws = ws;
    ws.on('open', () => ws === this.ws && this._onOpen(ws.fp));
    ws.on('close', () => this._socketClosed(ws));
  }

  // A WSS to the host; messages go to whichever role it has then (session, fallback, moving).
  _socket(address, port, transport) {
    const ws = new WebSocket('wss://' + address + ':' + port, {
      rejectUnauthorized: false, // self-signed; we pin the fingerprint instead
      maxPayload: P.MAX_PAYLOAD,
      handshakeTimeout: transport === 'ble' ? P.BLE_TIMEOUT_MS : 5000,
    });
    Object.assign(ws, { transport, fp: '', lastRx: Date.now() });
    ws.on('upgrade', (res) => {
      ws.fp = P.normFingerprint(res.socket.getPeerCertificate().fingerprint256);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      ws.lastRx = Date.now();
      if (ws === this.ws || ws === this.alt) this._onMessage(String(data), ws);
      else if (ws === this.pending) this._onPending(String(data));
    });
    ws.on('error', (err) => {
      if (ws === this.ws) this.lastError = err.code || err.message;
    });
    return ws;
  }

  _socketClosed(ws) {
    if (ws === this.pending) {
      this.pending = null;
      this.resumeAt = Date.now() + RESUME_RETRY_MS;
      return;
    }
    if (ws === this.alt) {
      this.alt = null;
      return this._emit('transport', {});
    }
    if (ws !== this.ws) return;
    const alt = this.alt;
    if (this.authed && alt && alt.readyState === WebSocket.OPEN) { // carry on through the other one
      this.alt = null;
      this.ws = alt;
      this.transport = alt.transport;
      console.log('[link] back on ' + (alt.transport === 'ble' ? 'Bluetooth' : 'the network'));
      return this._emit('transport', {});
    }
    this._onClose();
  }

  // On Bluetooth and the host is on the network now: move the session there.
  _tryResume() {
    if (!this.authed || this.transport !== 'ble' || this.pending || !this.resumeKey || Date.now() < (this.resumeAt || 0)) return;
    const seen = this.resolveAddress(this.pairing.macId);
    if (!seen || isBle(seen.address)) return;
    const ws = this._socket(seen.address, seen.port, 'ip');
    this.pending = ws;
    ws.on('open', () => {
      if (ws !== this.pending) return;
      if (ws.fp !== this.pairing.fp) return ws.terminate();
      ws.send(JSON.stringify({ t: T.HELLO, v: P.PROTOCOL_VERSION, id: this.device.id, name: this.device.name, os: P.OS.WIN, resume: this.resumeKey }));
    });
    ws.on('close', () => this._socketClosed(ws));
    setTimeout(() => ws === this.pending && ws.terminate(), 10000);
  }

  _onPending(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    const ws = this.pending;
    if (!msg || msg.t !== T.WELCOME || !msg.resumed) {
      if (msg && msg.t === T.ERROR) ws.terminate();
      return;
    }
    this.pending = null;
    if (this.alt) { // moved before: the newest path replaces the current one (the server does the same)
      const old = this.ws;
      this.ws = null;
      old.terminate();
    } else {
      this.alt = this.ws;
    }
    this.ws = ws;
    this.transport = ws.transport;
    console.log('[link] moved to the network');
    this._emit('transport', {});
  }

  _onOpen(seenFp) {
    this.seenFp = seenFp;
    this.lastRx = Date.now();
    this.ws.lastRx = this.lastRx;
    this.transport = this.ws.transport;
    this.lastError = '';
    if (this.mode === 'pair') {
      this.nw = P.randomHex(16);
      this._raw({ t: T.PAIR_START, v: P.PROTOCOL_VERSION, id: this.device.id, name: this.device.name, os: P.OS.WIN, commit: P.commitOf(this.nw) });
      this.pairState.phase = 'starting';
      this._changed();
      return;
    }
    if (this.blocked()) { // another computer connected to us meanwhile
      this._closeSocket();
      return this._scheduleReconnect();
    }
    if (!seenFp || seenFp !== this.pairing.fp) {
      this._closeSocket();
      this._setStatus('identity_changed', 'This Mac looks different now. Forget it and pair again.');
      return;
    }
    this._hello();
  }

  _hello() {
    const p = this.pairing;
    this._raw({ t: T.HELLO, v: P.PROTOCOL_VERSION, id: this.device.id, name: this.device.name, os: P.OS.WIN, token: p.token, mesh: 1, ...(this.takeover ? { takeover: true } : {}) });
    this.timers.hello = setTimeout(() => {
      this.lastError = 'No welcome from {name}';
      if (this.ws) this.ws.terminate();
    }, this.transport === 'ble' ? P.BLE_TIMEOUT_MS : HELLO_TIMEOUT_MS);
  }

  _onMessage(text, ws = this.ws) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    this.lastRx = Date.now();
    switch (msg.t) {
      case T.PAIR_NONCE: return this._onNonce(msg);
      case T.PAIR_OK: return this._onPairOk(msg);
      case T.PAIR_CANCEL: return this._pairFailed('Pairing was cancelled on {name}.');
      case T.WELCOME: return this._onWelcome(msg);
      case T.ERROR: return this._onError(msg);
      case T.PING: return this.authed && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: T.PONG, ts: msg.ts }));
      case T.PONG:
        if (typeof msg.ts === 'number') this.status.rtt = Math.max(0, Date.now() - msg.ts);
        return this._changed();
    }
    if (!this.authed) return;
    if (this.onAny) return this.onAny(msg);
    const fns = this.handlers.get(msg.t);
    if (fns) for (const fn of fns) fn(msg);
    else if (!this.unknown.has(msg.t)) {
      this.unknown.add(msg.t);
      console.log('[link] ignoring message type', msg.t);
    }
  }

  _onNonce(msg) {
    const ps = this.pairState;
    if (this.mode !== 'pair' || !ps || !this.nw || this.nm) return;
    if (typeof msg.nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(msg.nonce) || msg.nonce.length % 2) {
      return this._pairFailed('{Name} sent a bad pairing message.');
    }
    this.nm = msg.nonce;
    this._raw({ t: T.PAIR_REVEAL, nonce: this.nw });
    ps.code = P.sasCode(this.seenFp, this.nw, this.nm);
    ps.phase = 'code';
    this._changed();
  }

  _onPairOk(msg) {
    const ps = this.pairState;
    if (this.mode !== 'pair' || !ps || ps.phase !== 'waiting') return;
    if (typeof msg.token !== 'string' || !msg.token || typeof msg.macId !== 'string') {
      return this._pairFailed('{Name} sent a bad pairing message.');
    }
    this.pairing = {
      macId: msg.macId,
      macName: typeof msg.macName === 'string' && msg.macName ? msg.macName : ps.macName,
      address: ps.address,
      port: ps.port,
      fp: this.seenFp,
      token: msg.token,
      os: osOf(msg.os), // the host's OS; older Macs send none
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
    this.resumeKey = typeof msg.resume === 'string' ? msg.resume : ''; // older hosts: none, no moving
    this.resumeAt = 0;
    const os = osOf(msg.os || this.pairing.os);
    if ((typeof msg.macName === 'string' && msg.macName && msg.macName !== this.pairing.macName) || os !== this.pairing.os) {
      if (typeof msg.macName === 'string' && msg.macName) this.pairing.macName = msg.macName;
      this.pairing.os = os;
      this.store.save(this.pairing);
    }
    this.status.rtt = null;
    this.lastTx = Date.now();
    this.timers.ping = setInterval(() => this._keepalive(), KEEPALIVE_TICK_MS);
    this.takeover = false;
    this.busyBy = '';
    this._setStatus('connected', '');
    this._emit('welcome', msg);
  }

  _onError(msg) {
    const code = msg.code;
    if (this.mode === 'pair') return this._pairFailed(PAIR_ERRORS[code] || 'Pairing failed (' + code + ').');
    if (code === P.E.BAD_TOKEN) {
      this.forget();
      this._setStatus('not_paired', 'Your Mac forgot {me}. Pair again.');
      return;
    }
    if (code === P.E.VERSION_MISMATCH) this.lastError = PAIR_ERRORS[code];
    else if (code === P.E.REPLACED || code === P.E.RELEASED) {
      this.stopped = { why: code, message: String(msg.message || (code === P.E.RELEASED ? '{Name} disconnected' : 'Another device took over')).slice(0, 120) };
    } else if (code === P.E.BUSY) this.lastError = this.busyBy = String(msg.message || 'In use by another device').slice(0, 120);
    else this.lastError = '{Name} closed the link (' + code + ')';
    // The Mac closes the socket after an error; _onClose reconnects.
  }

  _pairFailed(error) {
    const ps = this.pairState;
    if (!ps) return;
    ps.phase = 'failed';
    ps.error = error;
    ps.code = '';
    this._closeSocket();
    this._changed();
    this._resume();
  }

  _onClose() {
    const wasAuthed = this.authed;
    this._clearSocketTimers();
    this.ws = null;
    for (const k of ['alt', 'pending']) {
      const x = this[k];
      this[k] = null;
      if (x) x.terminate();
    }
    this.authed = false;
    if (wasAuthed) this._emit('closed', {});
    if (this.mode === 'pair') {
      const ps = this.pairState;
      if (ps && ps.phase !== 'failed') {
        const nobody = /^(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(this.lastError);
        this._pairFailed(ps.phase === 'connecting'
          ? (nobody ? 'No TwinDesk at ' + ps.address + '.' : 'Could not connect to ' + ps.address + (this.lastError ? ' (' + this.lastError + ')' : '') + '.')
          : 'The connection to {name} closed.');
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

  _scheduleReconnect() {
    if (this.destroyed) return;
    clearTimeout(this.timers.reconnect);
    const delays = P.RECONNECT_MS;
    if (this.stopped) return this._setStatus('stopped', this.stopped.message);
    // In use by another device: now and then (and at once when the host says it's free: poke).
    const delay = this.busyBy ? 10000 : delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this._setStatus('reconnecting', this.lastError || '');
    this.timers.reconnect = setTimeout(() => {
      if (!this.pairing || this.pairState) return;
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
    this.seq++;
    this.ws = null;
    for (const k of ['alt', 'pending']) {
      const x = this[k];
      this[k] = null;
      if (x) x.terminate();
    }
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
      this.lastTx = this.ws.lastTx = Date.now();
    }
  }

  _keepalive() {
    const now = Date.now();
    const busy = this.busy();
    // Each socket on its own (a quiet fallback goes, the session lives on). A busy link pings every
    // PING_MS (each end measures the round trip); an idle one only when quiet for IDLE_PING_MS.
    // Through Bluetooth a big message takes seconds: its bytes count as a sign of life.
    for (const ws of [this.ws, this.alt]) {
      if (!ws || !ws.transport) continue;
      const ble = ws.transport === 'ble';
      const rx = Math.max(ws.lastRx || 0, (ble && this.ble && this.ble.lastDown) || 0);
      if (now - rx > (ble ? P.BLE_TIMEOUT_MS : busy ? P.TIMEOUT_MS : P.IDLE_TIMEOUT_MS)) {
        if (ws === this.ws) this.lastError = '{Name} stopped answering';
        ws.terminate();
      } else if (ws.readyState === WebSocket.OPEN && (busy ? now - (ws.lastPing || 0) >= P.PING_MS : now - (ws.lastTx || 0) >= P.IDLE_PING_MS)) {
        ws.lastPing = now;
        ws.lastTx = now;
        ws.send(JSON.stringify({ t: T.PING, ts: now }));
      }
    }
    this._tryResume();
  }

  // Local events ('welcome', 'closed') share the handler table with message types.
  _emit(type, msg) {
    const fns = this.handlers.get(type);
    if (fns) for (const fn of fns) fn(msg);
  }

  _setStatus(state, message) {
    this.status.state = state;
    this.status.message = message;
    if (state !== 'connected') this.status.rtt = null;
    this._changed();
  }

  _changed() {
    for (const fn of this.stateFns) fn();
  }
}

module.exports = Link;
