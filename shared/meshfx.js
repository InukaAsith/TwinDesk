// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files in Multi-device (mac|windows|linux/mesh): shared/fastfile.js once per session, as the
// one-to-one app has it once for its one peer. Each session its own token (the guest's hello fx: 1,
// the host's welcome fx: token); a request to our server goes to the session whose token it carries.
// Not the files engine (fx2) and not unencrypted transfers: those serve one session at a time.
//
//   const shared = hooks()                       the receivers' hooks, the same for every session
//   sessionFx(session, shared)                   → its FastFiles; session._deliver(m, true) skips it,
//                                                  session._fxSession() says what it needs
//   route(list, req, res)                        the server's: true when a session took the request
//   facadeFx(current, list, shared)              → what the one-to-one features use as `fx`
//                                                  (filesend, drop, Engines in use) for the selected device
'use strict';

const { FastFiles } = require('./fastfile.js');

const TOKEN = /^[0-9a-f]{32}$/;

function hooks() {
  return { pressures: [], hooks: [], active: null, onFallback: null };
}

function sessionFx(s, shared) {
  const fx = new FastFiles({ session: () => s._fxSession(), deliver: (m) => s._deliver(m, true), send: (m) => s.send(m), fx2: null });
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
  return { host: false, token: link.fx, transport, address: link.fxAddress || link.pairing.address, port: link.pairing.port, fp: link.pairing.fp, fx2: false };
}

function hostInfo(ctx, transport) {
  if (!ctx || !ctx.fx) return null;
  return { host: true, token: ctx.fx, plainToken: '', transport, address: ctx.address, fx2: false };
}

// The welcome's token (the guest's side), or ''.
const token = (msg) => (msg && typeof msg.fx === 'string' && TOKEN.test(msg.fx) ? msg.fx : '');

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

module.exports = { hooks, sessionFx, guestInfo, hostInfo, token, route, facadeFx };
