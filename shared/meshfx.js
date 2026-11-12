// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files in Multi-device (mac|windows|linux/mesh): shared/fastfile.js once per session, as the
// one-to-one app has it once for its one peer. Each session its own token (the guest's hello fx: 1,
// the host's welcome fx: token); a request to our server goes to the session whose token it carries.
// The files engine (fx2) too, Multi-device's own (shared/meshfx2.js): one engine, a view per session.
// No unencrypted transfers (fxPlain).
//
//   const shared = hooks()                       the receivers' hooks, the same for every session, and
//                                                  shared.fx2 (MeshFx2 | null: TWINDESK_NO_FX2)
//   sessionFx(session, shared)                   → its FastFiles; session._deliver(m, true) skips it,
//                                                  session._fxSession() says what it needs
//   route(list, req, res)                        the server's: true when a session took the request
//   facadeFx(current, list, shared)              → what the one-to-one features use as `fx`
//                                                  (filesend, drop, Engines in use) for the selected device
'use strict';

const { FastFiles } = require('./fastfile.js');

const TOKEN = /^[0-9a-f]{32}$/;

function hooks() {
  return { pressures: [], hooks: [], active: null, onFallback: null, fx2: require('./meshfx2.js').MeshFx2.make() };
}

function sessionFx(s, shared) {
  s.fx2v = shared.fx2 ? shared.fx2.view() : null; // need(on) while the session is up
  const fx = new FastFiles({ session: () => s._fxSession(), deliver: (m) => s._deliver(m, true), send: (m) => s.send(m), fx2: s.fx2v });
  fx.pressures = shared.pressures;
  fx.hooks = shared.hooks;
  fx.active = () => shared.active && shared.active();
  fx.onFallback = (o) => shared.onFallback && shared.onFallback(o);
  return fx;
}

// What FastFiles needs: as the guest (link: the token from its welcome, where we reached the host),
// as the host (ctx: the token we gave). null: none (an older app).
function guestInfo(link, transport) {
  if (!link || !link.fx) return null;
  return { host: false, token: link.fx, transport, address: link.fxAddress || link.pairing.address, port: link.pairing.port, fp: link.pairing.fp, fx2: !!link.fx2Port, fx2Port: link.fx2Port || 0 };
}

function hostInfo(ctx, transport) {
  if (!ctx || !ctx.fx) return null;
  return { host: true, token: ctx.fx, plainToken: '', transport, address: ctx.address, fx2: !!ctx.fx2 };
}

// The welcome's token (the guest's side), or ''.
const token = (msg) => (msg && typeof msg.fx === 'string' && TOKEN.test(msg.fx) ? msg.fx : '');

// The welcome's files engine port (the guest's side), or 0.
const fx2Port = (msg) => {
  const p = msg && msg.fx2 && typeof msg.fx2 === 'object' ? msg.fx2.port : 0;
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0;
};

// The server's side (session.js attaches it): the engine listens with the server's identity, starts
// as a socket comes in, and its port goes in a welcome that asked (server.js waits a moment for it).
function attachServer(shared, server) {
  const m = shared.fx2;
  if (!m) return;
  m.listen(server.tls);
  server.fx2Port = () => m.port;
  server.fx2Wait = (ms) => m.whenReady(ms);
  server.https.on('secureConnection', () => m.warm());
}

// The guest's side: hello says fx2 while the engine can run.
function attachLink(shared, link) {
  const m = shared.fx2;
  link.fx2Hello = () => { if (!m) return false; m.warm(); return m.fx2.client; };
}

function route(list, req, res) {
  const tok = req.headers['x-twindesk-fx'];
  if (!tok) return false;
  for (const s of list) if (s.hostUp && s.ctx.fx && s.ctx.fx === tok) return s.fx.request(req, res);
  return false;
}

function facadeFx(current, list, shared) {
  const cur = () => { const s = current(); return s && s.fx ? s.fx : null; };
  return {
    usable: () => { const f = cur(); return !!f && f.usable(); },
    get parallel() { const f = cur(); return f ? f.parallel : 1; },
    parallelFor: (size) => { const f = cur(); return f ? f.parallelFor(size) : 1; },
    send: (id, path, size, onBytes) => {
      const f = cur();
      if (f) return f.send(id, path, size, onBytes);
      const e = new Error('no fast files');
      e.early = true;
      return Promise.reject(e);
    },
    endFields: (id) => { const f = cur(); return f ? f.endFields(id) : {}; },
    cancel: (id) => { for (const s of list()) if (s.fx) s.fx.cancel(id); },
    sentChunk: () => { const f = cur(); if (f) f.sentChunk(); },
    describe: () => { const f = cur(); return f ? f.describe() : { next: 'chunk', why: 'peer', plain: false, last: null }; },
    pressure: (fn) => shared.pressures.push(fn),
    receiver: (hook) => shared.hooks.push(hook),
    set active(fn) { shared.active = fn; }, // () on bytes either way (netlink.js keeps a link made for files up)
    set onFallback(fn) { shared.onFallback = fn; },
  };
}

module.exports = { hooks, sessionFx, guestInfo, hostInfo, token, fx2Port, attachServer, attachLink, route, facadeFx };
