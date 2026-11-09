// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Host role (Linux ↔ Linux, Linux ↔ PC): HTTPS + WebSocket server on PORT: sessions,
// liveness, routing of authenticated messages. Copy of windows/server.js; the certificate comes
// from identity.js (PEM made by openssl).
//
// Events:
//   'preauth' (ctx, msg)  — hello / pair.* before auth (pairing.js handles them)
//   'client'  (ctx)       — a client got `welcome`
//   'message' (msg, ctx)  — any message from the authenticated client except ping/pong (peer.js routes)
//   'closed'  (ctx)       — a socket closed (authed or not)
//   'rtt'     (ctx)       — ctx.rttMs updated
//   'transport' (ctx)     — the session moved to another socket (hello {resume}) or back (ctx.transport)
//   'listening' / 'listenError' (err)
//   'phoneFree'           — a phone's hold on the session ended (computers may connect again)
'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const P = require('../shared/protocol.js');
const Quiet = require('../shared/quiet.js'); // idle sessions stop pinging every second (#143)

const ICE_OFFERS = new Set([P.T.RTC_OFFER, P.T.AUDIO_OFFER]);
const isLoopback = (a) => a === '127.0.0.1' || a === '::1';

// Dev only: listen elsewhere (a second copy on the same computer).
const LISTEN_PORT = Number(process.env.MACSHARE_DEV_PORT) || P.PORT;

class Server extends EventEmitter {
  constructor({ key, cert }) {
    super();
    this.current = null; // ctx of the authenticated client
    this.phoneGrace = null; // {id, until}: a phone's session just dropped, it may come back (P.PHONE_GRACE_MS)
    this.sockets = new Set();
    this.blePorts = new Map(); // local ports of our own connections that carry a Bluetooth pipe (blepipe.js) -> last bytes
    this.tls = { key, cert }; // also the shared folder's server (shared/foldershare.js)
    this.https = https.createServer(this.tls);
    this.https.requestTimeout = 0; // not Node's 5-min cap on a whole request: fast files' PUTs (a phone's, a guest's) outlast it
    this.wss = new WebSocketServer({ server: this.https, maxPayload: P.MAX_PAYLOAD });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.wss.on('error', () => {}); // ws repeats the server's errors here; listenError below reports them
    this.https.on('error', (err) => this.emit('listenError', err)); // e.g. EADDRINUSE: another copy listens
    this.port = LISTEN_PORT;
    this.https.listen(LISTEN_PORT, '0.0.0.0', () => this.emit('listening'));
    this.tick = null; // the liveness timer: only while there are sockets (_arm), none on an idle tray
    this.unquiet = Quiet.onChange(() => { if (this.tick) this._liveness(); }); // a hold reaches the other end at once
  }

  _onConnection(ws, req) {
    const now = Date.now();
    const ctx = {
      ws,
      authed: false,
      deviceId: null,
      name: null,
      address: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      connectedAt: now,
      lastRx: now,
      rttMs: null,
      // 'ble': through a Bluetooth pipe (our own connection from 127.0.0.1), else the network
      transport: 'ip',
      alt: null, // the session's other socket, if it moved (resume): the fallback
    };
    if (isLoopback(ctx.address) && this.blePorts.has(req.socket.remotePort)) ctx.transport = 'ble';
    Object.assign(ws, { ctx, lastRx: now, transport: ctx.transport, address: ctx.address, blePort: ctx.transport === 'ble' ? req.socket.remotePort : 0 });
    // At most 16 sockets from one address that haven't authenticated (a LAN peer can't open
    // thousands and hold each for UNAUTH_TIMEOUT_MS): past that the oldest goes, never the new one,
    // so a phone retrying on flaky Wi-Fi always gets in. Our own Bluetooth/wired pipes are loopback.
    if (!isLoopback(ctx.address)) {
      const waiting = [];
      for (const c of this.sockets) if (!c.authed && c.address === ctx.address) waiting.push(c);
      if (waiting.length >= 16) waiting[0].ws.terminate(); // a Set keeps insertion order: the oldest
    }
    this.sockets.add(ctx);
    this._arm();
    ws.on('message', (data, isBinary) => this._onMessage(ws.ctx, data, isBinary, ws));
    ws.on('close', (code, reason) => this._onSocketClose(ws, code, String(reason || '')));
    ws.on('error', (err) => console.error(`[server] socket ${ws.address}: ${err.message}`));
  }

  _onSocketClose(ws, code, reason) {
    const ctx = ws.ctx;
    if (ws.detached) return;
    if (ctx.authed) { // which path went, and how (1000/1001: closed on purpose there; 1006: the connection dropped)
      const path = ws.transport === 'ble' ? 'Bluetooth' : ws.address;
      console.log(`[server] ${ctx.name}: ${ctx.alt === ws ? 'fallback' : 'session'} socket on ${path} closed (${code || '?'}${reason ? ` ${reason}` : ''}) after ${Math.round((Date.now() - ctx.connectedAt) / 1000)} s`);
    }
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
    if (this.current === ctx) {
      this.current = null;
      if (P.isPhoneOs(ctx.os) && !ctx.released) this._phoneGrace(ctx.deviceId);
    }
    this.emit('closed', ctx);
  }

  // hello {resume}: the session's guest reached us another way (the network, once both are on one).
  // The new socket becomes the session's, the old one stays as the fallback.
  _resume(tmp, msg) {
    const c = this.current;
    if (!c || !c.resumeKey || msg.resume !== c.resumeKey || msg.id !== c.deviceId) {
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
    ctx.lastRx = ws.lastRx = Date.now();
    let msg;
    try {
      if (isBinary) throw new Error('binary');
      msg = JSON.parse(data.toString('utf8'));
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('no t');
    } catch (e) {
      return this.fail(ctx, P.E.BAD_MESSAGE, 'Expected a JSON object with a "t" field');
    }

    if (!ctx.authed) {
      if (this.asleep && msg.t === P.T.HELLO) return this.fail(ctx, P.E.ASLEEP, 'Asleep'); // a dark wake: not for a session
      if (msg.t === P.T.HELLO && typeof msg.resume === 'string') return this._resume(ctx, msg);
      if (msg.t === P.T.HELLO || msg.t.startsWith('pair.')) return this.emit('preauth', ctx, msg);
      return this.fail(ctx, P.E.BAD_MESSAGE, `"${msg.t}" is not allowed before welcome`);
    }
    if (Quiet.seen(ws, msg)) return; // `idle {on}`: the other end's side of a quiet link

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
      if (typeof msg.ts === 'number' && ws === ctx.ws) { // the session's socket only, not the fallback's
        ctx.rttMs = Math.max(0, Date.now() - msg.ts);
        this.emit('rtt', ctx);
      }
      return;
    }
    this.emit('message', msg, ctx); // peer.js routes it by type
  }

  // Pings and silence checks every PING_MS while any socket is open; with none, nothing wakes the app.
  _arm() {
    if (this.tick || this.closed) return;
    this.tick = setInterval(() => {
      this._liveness();
      if (!this.sockets.size) { clearInterval(this.tick); this.tick = null; }
    }, P.PING_MS);
  }

  _liveness() {
    const now = Date.now();
    for (const ctx of this.sockets) {
      if (ctx.authed) {
        // Each of the session's sockets on its own (a quiet fallback goes; the session lives on).
        for (const ws of [ctx.ws, ctx.alt]) {
          if (!ws) continue;
          const limit = ws.transport === 'ble' ? P.BLE_TIMEOUT_MS : P.TIMEOUT_MS;
          let rx = Math.max(ws.lastRx, (ws.blePort && this.blePorts.get(ws.blePort)) || 0); // through Bluetooth, bytes of a big message count too
          // Quiet links (shared/quiet.js): both ends idle, a ping every few minutes. Not through Bluetooth.
          if (ws.transport !== 'ble' && ws.readyState === ws.OPEN) {
            const q = Quiet.tick(ws, now, rx, (m) => ws.send(JSON.stringify(m)));
            if (q.quiet) {
              if (q.dead) { console.log(`[server] ${ctx.name || ctx.address} silent on a quiet link, closing`); ws.terminate(); }
              else if (q.ping) ws.send(JSON.stringify({ t: P.T.PING, ts: now }));
              continue;
            }
            rx = q.rx;
          }
          if (now - rx > limit) {
            console.log(`[server] ${ctx.name || ctx.address} silent for ${limit} ms on ${ws.transport === 'ble' ? 'Bluetooth' : ws.address}, closing`);
            ws.terminate();
          } else if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ t: P.T.PING, ts: now }));
          }
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
    // Cursor › Mouse and keyboard over Bluetooth: the pointer and keys on that socket (shared/bleinput.js; null: off).
    const ws = this.bleInput ? this.bleInput.route(ctx.ws, ctx.alt, msg) : ctx.ws;
    Quiet.sent(ws, msg);
    ws.send(JSON.stringify(msg));
  }

  // Send to the authenticated client, if any.
  sendToClient(msg) {
    this.send(this.current, msg);
  }

  // Send an error and close the socket.
  fail(ctx, code, message) {
    console.log(`[server] ${ctx.name || ctx.address}${ctx.transport === 'ble' ? ' (Bluetooth)' : ''}: ${code}: ${message}`);
    this.send(ctx, { t: P.T.ERROR, code, message });
    if (ctx.alt) { // the whole session goes, not just this path of it
      const alt = ctx.alt;
      ctx.alt = null;
      alt.detached = true;
      alt.close();
    }
    ctx.ws.close();
  }

  // Mark ctx authenticated; a newer client replaces the older one.
  authenticate(ctx, who, welcome) {
    // Fast files v2: the files engine starts on demand (shared/fx2.js) and its port goes in this
    // welcome, so when it isn't listening yet (it usually is: someone nearby, the socket coming in
    // started it) the welcome waits for it, a few tens of ms. Never long: without it, the fx way.
    const wait = ctx.fxWanted && ctx.fx2Wanted && this.fxOn && !ctx.fx2Waited && this.fx2Wait ? this.fx2Wait(1500) : null;
    if (wait) {
      ctx.fx2Waited = true;
      const go = () => { if (!ctx.authed && this.sockets.has(ctx) && ctx.ws.readyState === ctx.ws.OPEN) this.authenticate(ctx, who, welcome); };
      return void wait.then(go, go);
    }
    const { deviceId, name, os } = who;
    if (this.current && this.current !== ctx) {
      const old = this.current;
      this.current = null;
      old.released = true; // taken over: a phone gets no grace
      // A computer a phone took over from waits and comes back when the phone lets go (busy);
      // one a computer took over from stays away until someone connects it again (replaced).
      if (P.isPhoneOs(os) && !P.isPhoneOs(old.os)) this.fail(old, P.E.BUSY, `In use by ${name}`);
      else this.fail(old, P.E.REPLACED, old.deviceId === deviceId ? 'Another connection from this device replaced this one' : `${name} took over`);
    }
    ctx.authed = true;
    ctx.deviceId = deviceId;
    ctx.name = name;
    ctx.os = os;
    ctx.ice = this.iceFor ? this.iceFor(ctx) : null; // a phone through adb reverse: the relay's RTCConfiguration
    ctx.resumeKey = P.randomHex(16);
    // Fast files (shared/fastfile.js): when its hello asked and this app serves them, a token for them.
    ctx.fx = ctx.fxWanted && this.fxOn ? P.randomHex(16) : '';
    // … and fast files v2 (shared/fx2.js) when it asked too and our files engine is listening.
    ctx.fx2 = ctx.fx && ctx.fx2Wanted && this.fx2Port ? this.fx2Port() || 0 : 0;
    this.current = ctx;
    // The input lane (shared/inputlane.js): when its hello asked, over the network only.
    const il = ctx.ilWanted && ctx.transport === 'ip' && this.ilOffer ? this.ilOffer(ctx) : null;
    this.send(ctx, { ...welcome, resume: ctx.resumeKey, ...(ctx.fx ? { fx: ctx.fx } : {}), ...(ctx.fx2 ? { fx2: { port: ctx.fx2 } } : {}), ...(this.fxPlainOffer ? this.fxPlainOffer(ctx) : {}), ...(il ? { il } : {}) });
    this.emit('client', ctx);
  }

  // A phone holds the session (or just dropped it and may resume): computers are refused.
  phoneHolds() {
    if (this.current && P.isPhoneOs(this.current.os)) return true;
    return !!this.phoneGrace && Date.now() < this.phoneGrace.until;
  }

  _phoneGrace(id) {
    clearTimeout(this.graceTimer);
    this.phoneGrace = { id, until: Date.now() + P.PHONE_GRACE_MS };
    this.graceTimer = setTimeout(() => this.endPhoneGrace(), P.PHONE_GRACE_MS);
  }

  // The computers may connect again (the phone's grace ran out, or it was let go).
  endPhoneGrace() {
    clearTimeout(this.graceTimer);
    if (!this.phoneGrace) return;
    this.phoneGrace = null;
    this.emit('phoneFree');
  }

  // Disconnect on purpose (a phone or a computer): it doesn't resume or reconnect by itself, and
  // a computer may connect at once.
  release() {
    const c = this.current;
    if (c) {
      c.released = true;
      this.fail(c, P.E.RELEASED, 'The computer disconnected');
      setTimeout(() => c.ws.terminate(), 1000); // an older app never answers the close
    }
    this.endPhoneGrace();
  }

  // The computer is going to sleep (powerMonitor 'suspend'): the session ends with `asleep`, and
  // until it wakes for real ('resume') hellos are refused. A dark wake (Power Nap, network upkeep)
  // answers for a few seconds now and then: a guest let in then only went silent again, every ~20 s.
  // Returns the guest's device id (main invites it back on waking), or ''.
  sleep(on) {
    this.asleep = !!on;
    const c = on && this.current;
    if (!c) return '';
    c.released = true; // no phone grace: it's told why
    this.fail(c, P.E.ASLEEP, 'Went to sleep');
    return c.deviceId || '';
  }

  // Close every socket that belongs to a device id (used by Forget).
  closeDevice(deviceId, code, message) {
    for (const ctx of this.sockets) if (ctx.deviceId === deviceId) this.fail(ctx, code, message);
  }

  close() {
    this.closed = true;
    if (this.unquiet) this.unquiet();
    clearInterval(this.tick);
    this.tick = null;
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
