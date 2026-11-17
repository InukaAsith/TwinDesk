// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos › Save and Files › Save come back as an ordinary Send (file.offer drop:'send').
// Take files can be off, so that one transfer is allowed only for the authenticated socket
// that was asked: the same physical socket, one batch, and only until it finishes, is stopped,
// is forgotten, or the wait runs out. Another device, a later socket from the same device,
// a closed or replaced socket, or a Send nobody asked for stays refused (#239).
//
// file.offer has no id for the media.save / fs.save that asked. The first Send on this
// socket — a new batch, not a continuation of an older one — consumes the allowance.
// That file is not checked to be the photo or path that was asked for. That is a limit of
// the protocol: the offer cannot name the Save, so the first new batch on the socket that
// was asked is the one taken.
'use strict';

const DEFAULT_MS = 120000;
const OPEN = 1; // WebSocket.OPEN, without requiring the ws package

// Still the socket a Save was written to, or that a file.offer arrived on. Stop sets
// `released` before the closed event, and close() leaves readyState CLOSING before that
// event. A replaced socket is a different object, or this one is no longer OPEN.
function socketOpen(ws) {
  return !!ws && typeof ws === 'object' && ws.readyState === OPEN && ws.released !== true;
}

// A context object is not a socket. Treating it as one keeps the host ctx when send() used
// the guest link, and it stays true after that ctx's socket has been replaced.
function asSocket(sock) {
  if (!socketOpen(sock)) return null;
  if (sock.ws && sock.ws !== sock) return null;
  if (sock.authed === false || sock.released === true) return null;
  return sock;
}

// The physical socket of this view. Mesh passes source(): the outbound socket for a Save,
// or the socket a message arrived on (captured then, checked again here). One-to-one passes
// the ctx; its socket is ws. A released ctx or a closed socket is refused now, not when
// 'closed' arrives. Device id is not an identity.
function connectionOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  if (ctx.released === true || ctx.authed !== true) return null;
  if (typeof ctx.deviceId !== 'string' || !ctx.deviceId) return null;
  let sock = null;
  if (typeof ctx.source === 'function') {
    try { sock = ctx.source(); } catch { return null; }
  } else if (Object.prototype.hasOwnProperty.call(ctx, 'conn')) {
    sock = ctx.conn;
  } else {
    sock = ctx.ws;
  }
  sock = asSocket(sock);
  if (!sock) return null;
  if (typeof sock.deviceId === 'string' && sock.deviceId && sock.deviceId !== ctx.deviceId) return null;
  return { conn: sock, deviceId: ctx.deviceId };
}

class AskedSends {
  constructor({ now = () => Date.now(), wait = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout, ms = DEFAULT_MS } = {}) {
    this.now = now;
    this.wait = wait;
    this.cancel = cancel;
    this.ms = ms;
    this.open = null; // {conn, deviceId, until, batch, timer}; not named grant: that is the method
  }

  // One pending transfer for this session. A later ask replaces it.
  grant(session, ms = this.ms) {
    this.clear();
    const live = connectionOf(session);
    if (!live) return false;
    const open = { conn: live.conn, deviceId: live.deviceId, until: this.now() + ms, batch: '', timer: null };
    this.open = open;
    open.timer = this.wait(() => { if (this.open === open) this.clear(); }, ms);
    if (open.timer && typeof open.timer.unref === 'function') open.timer.unref();
    return true;
  }

  // True for the granted socket's one Send: the first batch, the rest of its files, or the
  // continuation of that same batch. Nothing else, and nothing after the wait.
  // The first offer is not matched to the Save. Any new batch on this socket may take it.
  // The socket is checked again: Stop, a close, or a replacement refuses before 'closed'.
  allow(ctx, msg) {
    const g = this.open;
    if (!g || !socketOpen(g.conn)) {
      if (g) this.clear();
      return false;
    }
    const live = connectionOf(ctx);
    if (!live || live.conn !== g.conn || live.deviceId !== g.deviceId) return false;
    if (this.now() >= g.until) {
      this.clear();
      return false;
    }
    if (!msg || msg.drop !== 'send' || typeof msg.batch !== 'string' || !msg.batch) return false;
    if (!g.batch) return typeof msg.cont !== 'string' || !msg.cont;
    return msg.batch === g.batch || msg.cont === g.batch;
  }

  take(batch) {
    if (this.open && !this.open.batch && typeof batch === 'string' && batch) this.open.batch = batch;
  }

  // That transfer arrived whole: the exception ends with it.
  finish(batch, cont) {
    const g = this.open;
    if (!g || !g.batch) return;
    if (g.batch === batch || (cont && g.batch === cont)) this.clear();
  }

  // Stop or Forget of this socket, including a mesh view of it. The closed event may hand
  // over a ctx whose socket is already CLOSING, so connectionOf alone would miss it.
  release(ctx) {
    if (!this.open || !ctx || typeof ctx !== 'object') return;
    const live = connectionOf(ctx);
    const named = ctx.conn && typeof ctx.conn === 'object' ? ctx.conn : null;
    const ws = ctx.ws && typeof ctx.ws === 'object' ? ctx.ws : null;
    if ((live && live.conn === this.open.conn) || named === this.open.conn || ws === this.open.conn || ctx === this.open.conn) this.clear();
  }

  clear() {
    if (this.open && this.open.timer) this.cancel(this.open.timer);
    this.open = null;
  }
}

// PhoneHub 'asked' / 'unasked' onto the file receiver (Mac Drop). Windows and Linux keep
// their own window; this is the session-bound one.
function wireAsked(hub, drop) {
  if (!hub || !drop || typeof hub.on !== 'function' || typeof drop.allowAsked !== 'function') return;
  hub.on('asked', (session) => drop.allowAsked(session));
  hub.on('unasked', () => drop.clearAsked());
}

module.exports = { AskedSends, connectionOf, wireAsked, DEFAULT_MS };
