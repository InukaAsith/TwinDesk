// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on the connected phone, for the Phone page's media controls (ui-nowplaying.js): asked of
// the phone while Audio › Media controls on the Phone page is on (phone.media.want), its answer kept
// (phone.media, NowPlaying.kt), and Play, Pause, Next, Previous and Seek sent back.
// server: the phone link ('client', 'closed', 't:<type>', sendToClient); cfg() → settings.audio.
// Events: 'change'.
'use strict';

const { EventEmitter } = require('events');
const P = require('./protocol.js');

const T = P.T;
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

class NowPlaying extends EventEmitter {
  constructor({ server, cfg }) {
    super();
    Object.assign(this, { server, cfg });
    this.now = null; // {app, appName, title, artist, album, playing, duration, position, at, speed, next, prev, seek, art}
    this.why = ''; // nothing to say: 'listener' (the phone's notification access is off, or the standard app)
    this.lastPlay = 0;
    server.on('client', (ctx) => isPhone(ctx) && this.apply());
    server.on('closed', (ctx) => {
      if (!isPhone(ctx)) return;
      this.now = null;
      this.emit('change');
    });
    server.on(`t:${T.PHONE_MEDIA}`, (m, ctx) => isPhone(ctx) && this._got(m || {}));
  }

  // Not "on": that would hide EventEmitter's on(), and nothing could listen (it broke the PC's phone setup).
  get enabled() {
    return this.cfg().phoneMedia !== false;
  }

  // The setting changed, or a phone came: ask for it, or stop.
  apply() {
    if (!isPhone(this.server.current)) return;
    this.server.sendToClient({ t: T.PHONE_MEDIA_WANT, on: this.enabled });
    if (!this.enabled) this.now = null;
    this.emit('change');
  }

  _got(m) {
    // TwinDesk on the phone playing this computer's sound: not shown again (older phones sent it).
    if (!m.none && typeof m.app === 'string' && m.app.startsWith('com.twindesk.')) m = { none: true };
    if (m.none) {
      this.now = null;
      this.why = str(m.why, 40);
      return this.emit('change');
    }
    const art = typeof m.art === 'string' ? (m.art.startsWith('data:image/') && m.art.length < 200000 ? m.art : '') : this.now ? this.now.art : '';
    this.now = {
      app: str(m.app, 200), appName: str(m.appName, 100), title: str(m.title, 200), artist: str(m.artist, 200), album: str(m.album, 200),
      playing: m.playing === true, duration: Math.max(0, num(m.duration)), position: num(m.position), at: num(m.at) || Date.now(),
      speed: num(m.speed) || 1, next: m.next === true, prev: m.prev === true, seek: m.seek === true, art,
    };
    this.why = '';
    if (this.now.playing) this.lastPlay = Date.now();
    this.emit('change');
  }

  control(a, pos) {
    if (!['play', 'pause', 'toggle', 'next', 'prev', 'seek'].includes(a) || !isPhone(this.server.current)) return;
    this.server.sendToClient({ t: T.PHONE_MEDIA_CTL, a, ...(a === 'seek' ? { pos: Math.max(0, Math.round(num(pos))) } : {}) });
  }

  // For the Phone page: while it plays, and a few minutes after a pause (so it can go on again).
  get view() {
    const n = this.now;
    const show = !!n && this.enabled && (n.playing || Date.now() - this.lastPlay < 5 * 60000);
    return { on: this.enabled, why: this.why, now: show ? n : null };
  }
}

module.exports = { NowPlaying };
