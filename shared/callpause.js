// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Calls › Pause what plays here (settings.hub.callPause): a phone call ringing or under way pauses
// what plays on this computer (shared/web/pcmedia.js: macOS Now Playing, Windows' media session,
// Linux MPRIS, else the Play/Pause key), and the call ending plays it again, only if it was this
// that paused it (music you paused yourself stays paused).
//   const cp = new CallPause({ media: () => PcMedia | null, on: () => boolean })
//   hub.on('call', (call, was) => cp.onCall(call))
'use strict';

const RESUME_MS = 1000; // after the call's sound has left the speakers

class CallPause {
  constructor({ media, on }) {
    this.media = media;
    this.on = on;
    this.paused = false; // this paused it, and owes a play
    this.busy = false;
  }

  async onCall(call) {
    const active = !!call && (call.state === 'ringing' || call.state === 'offhook');
    const m = this.media && this.media();
    if (!m) return;
    if (active) {
      if (this.paused || this.busy || !this.on()) return;
      this.busy = true;
      try {
        await m.poll(); // what plays now (it's read only while asked otherwise)
        if (m.state().playing === true) {
          m.do('pause');
          this.paused = true;
        }
      } catch (_) { /* nothing known: nothing paused */ }
      this.busy = false;
      return;
    }
    if (!this.paused) return;
    this.paused = false;
    const t = setTimeout(() => { try { m.do('play'); } catch (_) { /* gone */ } }, RESUME_MS);
    if (t && t.unref) t.unref();
  }
}

module.exports = { CallPause };
