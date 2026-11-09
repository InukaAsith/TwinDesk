// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on this computer, for the phone (its Media page and the media notification in its
// shade, PcMedia.kt): read (shared/web/pcmedia.js) only while the phone asks (pc.media.want), sent
// on every change (pc.media), and Play, Pause, Next and Previous from there (pc.media.ctl).
//   macOS: any app in its Now Playing, with the artwork (Music and Spotify without mac-helper's dylib). Linux: any MPRIS player (playerctl). Windows: the system media session.
// server: the phone link ('client', 'closed', 't:<type>', sendToClient, current); key(code) presses a media key.
'use strict';

const P = require('./protocol.js');
const { PcMedia } = require('./web/pcmedia.js');

const T = P.T;
const isPhone = (ctx) => !!ctx && P.isPhoneOs(ctx.os); // Android or iPhone

class PcNow {
  constructor({ server, key, platform = process.platform }) {
    this.server = server;
    this.media = new PcMedia({ key, platform });
    this.want = false;
    this.sentArt = null; // the artwork the phone has (sent only when it changes)
    this.media.on('change', () => this.send());
    server.on('closed', (ctx) => isPhone(ctx) && this.stop());
    server.on(`t:${T.PC_MEDIA_WANT}`, (m, ctx) => {
      if (!isPhone(ctx || server.current)) return;
      this.want = !!(m && m.on);
      this.sentArt = null;
      this.media.active(this.want);
      if (this.want) this.send();
    });
    server.on(`t:${T.PC_MEDIA_CTL}`, (m, ctx) => {
      if (!isPhone(ctx || server.current) || !m) return;
      const a = m.a === 'prev' ? 'previous' : m.a;
      if (['play', 'pause', 'toggle', 'next', 'previous'].includes(a)) this.media.do(a);
    });
  }

  stop() {
    this.want = false;
    this.media.active(false);
  }

  send() {
    if (!this.want || !isPhone(this.server.current)) return;
    const s = this.media.state();
    if (!s || !s.title) { this.sentArt = null; return this.server.sendToClient({ t: T.PC_MEDIA, none: true }); }
    const ble = (this.server.current || {}).transport === 'ble'; // no artwork over Bluetooth: too slow for it
    const art = this.media.art && !ble ? this.media.art() : '';
    const m = { t: T.PC_MEDIA, ...s };
    if (art !== this.sentArt) { m.art = art; this.sentArt = art; } // left out: the one it has stays
    this.server.sendToClient(m);
  }
}

module.exports = { PcNow };
