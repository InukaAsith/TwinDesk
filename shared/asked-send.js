// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos › Save and Files › Save come back as an ordinary Send (file.offer drop:'send').
// Take files can be off, so that one transfer is allowed only for the authenticated session
// that was asked: the same connection, one batch, and only until it finishes, is stopped,
// is forgotten, or the wait runs out. Another device, a later connection from the same
// device, or a Send nobody asked for stays refused (#239).
//
// file.offer has no id for the media.save / fs.save that asked. The first Send on this
// connection — a new batch, not a continuation of an older one — consumes the allowance.
// That file is not checked to be the photo or path that was asked for.
'use strict';

const DEFAULT_MS = 120000;

// The session an offer belongs to. One-to-one passes the socket ctx, which stays the same
// when the transport moves and is a new object when another connection takes over. Mesh
// passes a fresh view; `conn` is that same session (the host ctx, or the guest socket).
function connectionOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(ctx, 'conn')) {
    const conn = ctx.conn;
    if (!conn || typeof conn !== 'object') return null;
    if (ctx.authed !== true || typeof ctx.deviceId !== 'string' || !ctx.deviceId) return null;
    if (typeof conn.deviceId === 'string' && conn.deviceId && conn.deviceId !== ctx.deviceId) return null;
    if (conn.authed === false) return null;
    return { conn, deviceId: ctx.deviceId };
  }
  if (ctx.authed !== true || typeof ctx.deviceId !== 'string' || !ctx.deviceId) return null;
  return { conn: ctx, deviceId: ctx.deviceId };
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

  // True for the granted session's one Send: the first batch, the rest of its files, or the
  // continuation of that same batch. Nothing else, and nothing after the wait.
  // The first offer is not matched to the Save. Any new batch from this connection may take it.
  allow(ctx, msg) {
    const g = this.open;
    const live = connectionOf(ctx);
    if (!g || !live || live.conn !== g.conn || live.deviceId !== g.deviceId) return false;
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

  // Stop or Forget of this session, including a mesh view of it.
  release(ctx) {
    if (!this.open || !ctx || typeof ctx !== 'object') return;
    const live = connectionOf(ctx);
    if ((live && live.conn === this.open.conn) || ctx === this.open.conn || ctx.conn === this.open.conn) this.clear();
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
