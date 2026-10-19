// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Host role (PC ↔ PC): HTTPS + WebSocket server on PORT: sessions, liveness, routing
// of authenticated messages. Port of mac/server.js; the certificate comes from identity.js (PKCS#12).
//
// Many clients at once (mesh): `clients` maps deviceId -> ctx for every authenticated client.
// `current` is the primary client (setPrimary(), else the most recently authenticated one,
// preferring a non-Android client); features that talk to "the phone" keep using it.
//
// Events:
//   'preauth' (ctx, msg)  — hello / pair.* before auth (hostpair.js handles them)
//   'client'  (ctx)       — a client got `welcome`
//   'message' (msg, ctx)  — any message from the authenticated client except ping/pong
//   'closed'  (ctx)       — a socket closed (authed or not)
//   'rtt'     (ctx)       — ctx.rttMs updated
//   'listening' / 'listenError' (err)
'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const P = require('../shared/protocol.js');

const ICE_OFFERS = new Set([P.T.RTC_OFFER, P.T.AUDIO_OFFER]);

// Dev only: listen elsewhere (a second copy on the same PC).
const LISTEN_PORT = Number(process.env.MACSHARE_DEV_PORT) || P.PORT;

// How often liveness is checked. A ping goes out only when nothing was sent for the interval.
const TICK_MS = 250;

class Server extends EventEmitter {
  // opts: pfx, passphrase; port (default PORT; 0 = any free port, see `port` after 'listening');
  //   now () -> ms (tests inject a fake clock); tick (false: no timer, call liveness() yourself).
  constructor({ pfx, passphrase, port, now, tick = true } = {}) {
    super();
    this.clients = new Map(); // deviceId -> ctx, authenticated and connected
    this.sockets = new Set(); // every ctx, authed or not
    this.primaryId = null; // setPrimary()
    this.busyFlags = new Map(); // deviceId -> boolean from setBusy()
    this.authSeq = 0; // orders authentications (most recent first)
    this.phoneGrace = null; // always null: a phone no longer holds the session (kept for phone.js)
    this._now = now || (() => Date.now());
    this.https = https.createServer({ pfx, passphrase });
    this.wss = new WebSocketServer({ server: this.https, maxPayload: P.MAX_PAYLOAD });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.wss.on('error', () => {}); // ws repeats the server's errors here; listenError below reports them
    this.https.on('error', (err) => this.emit('listenError', err)); // e.g. EADDRINUSE: another copy listens
    this.port = port !== undefined ? port : LISTEN_PORT;
    this.https.listen(this.port, '0.0.0.0', () => {
      this.port = this.https.address().port;
      this.emit('listening');
    });
    this.tick = tick ? setInterval(() => this.liveness(), TICK_MS) : null;
  }

  // The primary client: setPrimary()'s device while it is connected; else the most recently
  // authenticated one, a non-Android client first. null when nobody is connected.
  get current() {
    if (this.primaryId) {
      const c = this.clients.get(this.primaryId);
      if (c) return c;
    }
    let best = null;
    for (const c of this.clients.values()) {
      if (!best) best = c;
      else if ((best.os === P.OS.ANDROID) !== (c.os === P.OS.ANDROID)) {
        if (c.os !== P.OS.ANDROID) best = c;
      } else if (c.authSeq > best.authSeq) best = c;
    }
    return best;
  }

  // The client that is the primary one (null: the most recently authenticated again).
  setPrimary(deviceId) {
    this.primaryId = deviceId || null;
  }

  // A busy client (driving, driven, or selected) is pinged every PING_MS; the others every
  // IDLE_PING_MS. Default: the primary client is busy.
  setBusy(deviceId, flag) {
    this.busyFlags.set(deviceId, !!flag);
  }

  _isBusy(ctx) {
    const flag = this.busyFlags.get(ctx.deviceId);
    return flag === undefined ? ctx === this.current : flag;
  }

  _onConnection(ws, req) {
    const now = this._now();
    const ctx = {
      ws,
      authed: false,
      deviceId: null,
      name: null,
      os: null,
      authSeq: 0,
      address: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      connectedAt: now,
      lastRx: now,
      lastTx: now,
      rttMs: null,
    };
    this.sockets.add(ctx);
    ws.on('message', (data, isBinary) => this._onMessage(ctx, data, isBinary));
    ws.on('close', () => {
      this.sockets.delete(ctx);
      if (ctx.authed && this.clients.get(ctx.deviceId) === ctx) this.clients.delete(ctx.deviceId);
      this.emit('closed', ctx);
    });
    ws.on('error', (err) => console.error(`[server] socket ${ctx.address}: ${err.message}`));
  }

  _onMessage(ctx, data, isBinary) {
    ctx.lastRx = this._now();
    let msg;
    try {
      if (isBinary) throw new Error('binary');
      msg = JSON.parse(data.toString('utf8'));
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('no t');
    } catch (e) {
      return this.fail(ctx, P.E.BAD_MESSAGE, 'Expected a JSON object with a "t" field');
    }

    if (!ctx.authed) {
      if (msg.t === P.T.HELLO || msg.t.startsWith('pair.')) return this.emit('preauth', ctx, msg);
      return this.fail(ctx, P.E.BAD_MESSAGE, `"${msg.t}" is not allowed before welcome`);
    }

    if (msg.t === P.T.PING) return this.send(ctx, { t: P.T.PONG, ts: msg.ts });
    if (msg.t === P.T.PONG) {
      if (typeof msg.ts === 'number') {
        ctx.rttMs = Math.max(0, this._now() - msg.ts);
        this.emit('rtt', ctx);
      }
      return;
    }
    this.emit('message', msg, ctx); // peer.js routes it by type
  }

  // Pings the clients that have been silent for their interval, closes the ones silent too long.
  // Called by the timer; tests call it with a fake clock.
  liveness(now = this._now()) {
    for (const ctx of this.sockets) {
      if (ctx.authed) {
        const busy = this._isBusy(ctx);
        const timeout = busy ? P.TIMEOUT_MS : P.IDLE_TIMEOUT_MS;
        const every = busy ? P.PING_MS : P.IDLE_PING_MS;
        if (now - ctx.lastRx > timeout) {
          console.log(`[server] ${ctx.name || ctx.address} silent for ${timeout} ms, closing`);
          ctx.ws.terminate();
        } else if (now - ctx.lastTx >= every) {
          this.send(ctx, { t: P.T.PING, ts: now });
        }
      } else if (now - ctx.connectedAt > P.UNAUTH_TIMEOUT_MS) {
        ctx.ws.terminate();
      }
    }
  }

  send(ctx, msg) {
    if (!ctx || ctx.ws.readyState !== ctx.ws.OPEN) return;
    // A phone on the USB cable: its WebRTC goes through the relay too (wired.js).
    if (ctx.ice && ICE_OFFERS.has(msg.t)) msg = { ...msg, ice: ctx.ice };
    ctx.ws.send(JSON.stringify(msg));
    ctx.lastTx = this._now();
  }

  // Send to the primary client, if any.
  sendToClient(msg) {
    this.send(this.current, msg);
  }

  // Send an error and close the socket.
  fail(ctx, code, message) {
    this.send(ctx, { t: P.T.ERROR, code, message });
    ctx.ws.close();
  }

  // Mark ctx authenticated. A client with the same device id replaces the older socket of that
  // device only; other devices are untouched.
  authenticate(ctx, { deviceId, name, os }, welcome) {
    const old = this.clients.get(deviceId);
    if (old && old !== ctx) {
      this.clients.delete(deviceId);
      this.fail(old, P.E.REPLACED, 'Another connection from a paired device replaced this one');
    }
    ctx.authed = true;
    ctx.deviceId = deviceId;
    ctx.name = name;
    ctx.os = os;
    ctx.authSeq = ++this.authSeq;
    ctx.ice = this.iceFor ? this.iceFor(ctx) : null; // a phone through adb reverse: the relay's RTCConfiguration
    this.clients.set(deviceId, ctx);
    this.send(ctx, welcome);
    this.emit('client', ctx);
  }

  // Phones no longer hold the session: computers are never refused because of one.
  phoneHolds() {
    return false;
  }

  // Kept for phone.js and the app's phone code; no grace period is started any more.
  _phoneGrace() {}

  endPhoneGrace() {
    clearTimeout(this.graceTimer);
    if (!this.phoneGrace) return;
    this.phoneGrace = null;
    this.emit('phoneFree');
  }

  // Disconnect the phone on purpose (the primary client when it is a phone).
  releasePhone() {
    const c = this.current;
    if (c && c.os === P.OS.ANDROID) {
      c.released = true;
      this.fail(c, P.E.RELEASED, 'The PC disconnected the phone');
      setTimeout(() => c.ws.terminate(), 1000); // an older phone app never answers the close
    }
    this.endPhoneGrace();
  }

  // Close every socket that belongs to a device id (used by Forget).
  closeDevice(deviceId, code, message) {
    for (const ctx of this.sockets) if (ctx.deviceId === deviceId) this.fail(ctx, code, message);
  }

  close() {
    clearInterval(this.tick);
    clearTimeout(this.graceTimer);
    for (const ctx of this.sockets) ctx.ws.terminate();
    this.wss.close();
    this.https.close();
  }
}

module.exports = { Server };
