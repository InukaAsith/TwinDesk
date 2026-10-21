// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// HTTPS + WebSocket server on PORT: many authenticated clients at once (mesh), liveness, routing of
// authenticated messages. The Mac is the native host here; the certificate comes from identity.js.
//
// Many clients at once (mesh): `clients` maps deviceId -> ctx for every authenticated client.
// `current` is the primary client (setPrimary(), else the most recently authenticated one,
// preferring a non-Android client); features that talk to "the phone" keep using it.
//
// A client's session can move between sockets (hello {resume}): ctx.ws is the live socket,
// ctx.alt the fallback. A socket can carry a Bluetooth pipe (ws.transport 'ble', blepipe.js).
//
// Events:
//   'preauth' (ctx, msg)  — hello / pair.* before auth (hostpair.js handles them)
//   'client'  (ctx)       — a client got `welcome`
//   'message' (msg, ctx)  — any message from the authenticated client except ping/pong (peer.js routes)
//   'closed'  (ctx)       — a socket closed (authed or not)
//   'rtt'     (ctx)       — ctx.rttMs updated
//   'transport' (ctx)     — the session moved to another socket (hello {resume}) or back (ctx.transport)
//   'listening' / 'listenError' (err)
//   'phoneFree'           — a phone's hold on the session ended (kept for the phone code)
'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const P = require('../shared/protocol.js');

const ICE_OFFERS = new Set([P.T.RTC_OFFER, P.T.AUDIO_OFFER]);
const isLoopback = (a) => a === '127.0.0.1' || a === '::1';

// Dev only (dev/stream-check): listen elsewhere so a running PC doesn't take over the session.
const LISTEN_PORT = Number(process.env.MACSHARE_DEV_PORT) || P.PORT;

// How often liveness is checked. A ping goes out only when nothing was sent for the interval.
const TICK_MS = 250;

class Server extends EventEmitter {
  // opts: pfx, passphrase; port (default PORT; 0 = any free port, see `port` after 'listening');
  //   now () -> ms (tests inject a fake clock); tick (false: no timer, call liveness() yourself).
  constructor({ keyPem, certPem, port, now, tick = true } = {}) {
    super();
    this.clients = new Map(); // deviceId -> ctx, authenticated and connected
    this.sockets = new Set(); // every ctx, authed or not
    this.primaryId = null; // setPrimary()
    this.busyFlags = new Map(); // deviceId -> boolean from setBusy()
    this.authSeq = 0; // orders authentications (most recent first)
    this.phoneGrace = null; // always null: a phone no longer holds the session (kept for phone.js)
    this.blePorts = new Map(); // local ports of our own connections that carry a Bluetooth pipe (blepipe.js) -> last bytes
    this._now = now || (() => Date.now());
    this.tls = { key: keyPem, cert: certPem }; // also the shared folder's server (shared/foldershare.js)
    this.https = https.createServer(this.tls);
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
      // 'ble': through a Bluetooth pipe (our own connection from 127.0.0.1), else the network
      transport: 'ip',
      alt: null, // the session's other socket, if it moved (resume): the fallback
    };
    if (isLoopback(ctx.address) && this.blePorts.has(req.socket.remotePort)) ctx.transport = 'ble';
    Object.assign(ws, { ctx, lastRx: now, lastTx: now, transport: ctx.transport, address: ctx.address, blePort: ctx.transport === 'ble' ? req.socket.remotePort : 0 });
    this.sockets.add(ctx);
    ws.on('message', (data, isBinary) => this._onMessage(ws.ctx, data, isBinary, ws));
    ws.on('close', () => this._onSocketClose(ws));
    ws.on('error', (err) => console.error(`[server] socket ${ws.address}: ${err.message}`));
  }

  _onSocketClose(ws) {
    const ctx = ws.ctx;
    if (ws.detached) return;
    if (ctx.alt === ws) {
      ctx.alt = null;
      return this.emit('transport', ctx);
    }
    if (ctx.ws !== ws) return;
    // The session's socket went, its other one is still there: carry on through that one.
    const alt = ctx.alt;
    if (alt && alt.readyState === alt.OPEN) {
      ctx.alt = null;
      Object.assign(ctx, { ws: alt, transport: alt.transport, address: alt.address });
      console.log(`[server] ${ctx.name}: back on ${alt.transport === 'ble' ? 'Bluetooth' : alt.address}`);
      return this.emit('transport', ctx);
    }
    this.sockets.delete(ctx);
    if (ctx.authed && this.clients.get(ctx.deviceId) === ctx) this.clients.delete(ctx.deviceId);
    this.emit('closed', ctx);
  }

  // hello {resume}: the session's guest reached us another way (the network, once both are on one,
  // or Bluetooth). The new socket becomes the session's, the old one stays as the fallback.
  _resume(tmp, msg) {
    const c = [...this.clients.values()].find((x) => x.resumeKey && x.resumeKey === msg.resume && x.deviceId === msg.id);
    if (!c) {
      return this.fail(tmp, P.E.BAD_MESSAGE, 'Nothing to resume');
    }
    this.sockets.delete(tmp);
    const ws = tmp.ws;
    if (c.alt) { // already moved once: the newest path replaces the current one
      c.ws.detached = true;
      c.ws.terminate();
    } else {
      c.alt = c.ws;
    }
    ws.ctx = c;
    Object.assign(c, { ws, transport: ws.transport, address: ws.address });
    ws.send(JSON.stringify({ t: P.T.WELCOME, v: P.PROTOCOL_VERSION, resumed: true }));
    console.log(`[server] ${c.name}: moved to ${ws.transport === 'ble' ? 'Bluetooth' : ws.address}`);
    this.emit('transport', c);
  }

  _onMessage(ctx, data, isBinary, ws) {
    const now = this._now();
    ctx.lastRx = now;
    if (ws) ws.lastRx = now;
    let msg;
    try {
      if (isBinary) throw new Error('binary');
      msg = JSON.parse(data.toString('utf8'));
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('no t');
    } catch (e) {
      return this.fail(ctx, P.E.BAD_MESSAGE, 'Expected a JSON object with a "t" field');
    }

    if (!ctx.authed) {
      if (msg.t === P.T.HELLO && typeof msg.resume === 'string') return this._resume(ctx, msg);
      if (msg.t === P.T.HELLO || msg.t.startsWith('pair.')) return this.emit('preauth', ctx, msg);
      return this.fail(ctx, P.E.BAD_MESSAGE, `"${msg.t}" is not allowed before welcome`);
    }

    if (msg.t === P.T.PING) return this.send(ctx, { t: P.T.PONG, ts: msg.ts });
    if (msg.t === P.T.BYE) { // Disconnect there: nothing to wait for
      ctx.released = true;
      if (ctx.alt) { // the whole session goes, its fallback path too
        const alt = ctx.alt;
        ctx.alt = null;
        alt.detached = true;
        alt.close();
      }
      return ctx.ws.close();
    }
    if (msg.t === P.T.PONG) {
      if (typeof msg.ts === 'number') {
        ctx.rttMs = Math.max(0, this._now() - msg.ts);
        this.emit('rtt', ctx);
      }
      return;
    }
    this.emit('message', msg, ctx); // peer.js routes it by type
  }

  // Pings the sockets that have been silent for their interval, closes the ones silent too long.
  // Each of a session's sockets is checked on its own (a quiet fallback goes; the session lives on).
  // Called by the timer; tests call it with a fake clock.
  liveness(now = this._now()) {
    for (const ctx of this.sockets) {
      if (ctx.authed) {
        const busy = this._isBusy(ctx);
        for (const ws of [ctx.ws, ctx.alt]) {
          if (!ws) continue;
          const primary = ws === ctx.ws; // the session's own socket: its times are the client's (ctx)
          const ble = ws.transport === 'ble';
          // through Bluetooth a big message takes seconds: bytes still arriving count as a sign of life
          const rx = Math.max(primary ? ctx.lastRx || 0 : ws.lastRx || 0, (ws.blePort && this.blePorts.get(ws.blePort)) || 0);
          const timeout = busy ? (ble ? P.BLE_TIMEOUT_MS : P.TIMEOUT_MS) : (ble ? P.BLE_TIMEOUT_MS : P.IDLE_TIMEOUT_MS);
          const every = busy ? P.PING_MS : P.IDLE_PING_MS;
          const tx = primary ? ctx.lastTx || 0 : ws.lastTx || 0;
          if (now - rx > timeout) {
            console.log(`[server] ${ctx.name || ctx.address} silent for ${timeout} ms on ${ble ? 'Bluetooth' : ws.address}, closing`);
            ws.terminate();
          } else if (ws.readyState === ws.OPEN && (busy ? now - (ws.lastPing || 0) >= every : now - tx >= every)) {
            // A busy link pings on its own every PING_MS (both ends measure the round trip, which the
            // window shows); an idle one only when nothing was sent for IDLE_PING_MS.
            ws.lastPing = now;
            if (primary) this.send(ctx, { t: P.T.PING, ts: now });
            else this._raw(ws, { t: P.T.PING, ts: now });
          }
        }
      } else if (now - ctx.connectedAt > P.UNAUTH_TIMEOUT_MS) {
        ctx.ws.terminate();
      }
    }
  }

  _raw(ws, msg) {
    ws.send(JSON.stringify(msg));
    ws.lastTx = this._now();
  }

  send(ctx, msg) {
    if (!ctx || ctx.ws.readyState !== ctx.ws.OPEN) return;
    // A phone on the USB cable: its WebRTC goes through the relay too (wired.js).
    if (ctx.ice && ICE_OFFERS.has(msg.t)) msg = { ...msg, ice: ctx.ice };
    this._raw(ctx.ws, msg);
    ctx.lastTx = ctx.ws.lastTx;
  }

  // Send to the primary client, if any.
  sendToClient(msg) {
    this.send(this.current, msg);
  }

  // Send an error and close the socket(s) of that client.
  fail(ctx, code, message) {
    this.send(ctx, { t: P.T.ERROR, code, message });
    if (ctx.alt) { // the whole session goes, not just this path of it
      const alt = ctx.alt;
      ctx.alt = null;
      alt.detached = true;
      alt.close();
    }
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
    ctx.resumeKey = P.randomHex(16);
    this.clients.set(deviceId, ctx);
    this.send(ctx, { ...welcome, resume: ctx.resumeKey });
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

  // Disconnect a client on purpose (a phone or a computer): it doesn't resume or reconnect by itself,
  // and the other side may connect at once. Default: the primary client.
  release(ctx = this.current) {
    if (ctx) {
      ctx.released = true;
      this.fail(ctx, P.E.RELEASED, 'The Mac disconnected');
      setTimeout(() => ctx.ws.terminate(), 1000); // an older app never answers the close
    }
    this.endPhoneGrace();
  }

  // Disconnect a phone on purpose (ctx: its client; default every phone client).
  releasePhone(ctx = null) {
    for (const c of this.clients.values()) {
      if (c.os !== P.OS.ANDROID || (ctx && c.deviceId !== ctx.deviceId)) continue;
      c.released = true;
      this.fail(c, P.E.RELEASED, 'The Mac disconnected the phone');
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
    for (const ctx of this.sockets) {
      if (ctx.alt) ctx.alt.terminate();
      ctx.ws.terminate();
    }
    this.wss.close();
    this.https.close();
  }
}

module.exports = { Server };
