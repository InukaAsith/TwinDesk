// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const P = require('./protocol.js');
const { connectionOf } = require('./asked-send.js');
const { PcMedia } = require('./web/pcmedia.js');

const CONFIRM_MS = 2000;
const sameConnection = (a, b) => !!a && !!b && a.conn === b.conn && a.deviceId === b.deviceId;

// Use the wire's explicit idle, since PhoneHub also clears its displayed call on disconnect.
// The stream is dedicated to the call so phone and web Now Playing subscriptions cannot stop it.
class CallMedia {
  constructor(hub, createMedia = () => new PcMedia()) {
    this.hub = hub;
    this.server = hub.server;
    this.createMedia = createMedia;
    this.call = null;
    this.server.on(`t:${P.T.CALL_STATE}`, (m, ctx, ws) => this.onCall(m.state, ctx, ws));
    for (const event of ['client', 'closed', 'transport']) this.server.on(event, () => this.refresh());
    hub.on('change', () => this.refresh());
  }

  enabled() {
    return this.hub.settings.calls && this.hub.settings.callPause === true;
  }

  current() {
    return connectionOf(this.server.current);
  }

  refresh() {
    if (!this.call) return;
    if (!sameConnection(this.call.connection, this.current())) this.reset();
    else if (!this.enabled()) this.stopWatching(this.call);
  }

  onCall(state, ctx, ws) {
    if (!ctx || !P.isPhoneOs(ctx.os) || !['ringing', 'offhook', 'idle'].includes(state)) return;
    this.refresh();
    const connection = connectionOf(ctx, ws);
    if (!sameConnection(connection, this.current())) return;

    if (state === 'idle') {
      const call = this.call;
      if (!call || call.ending) return;
      call.ending = true;
      if (call.paused) this.resume(call);
      else if (!call.pauseAccepted || !call.media) this.reset();
    } else if (!this.call || this.call.ending) {
      this.reset();
      const call = this.call = { connection, media: null };
      if (this.enabled()) this.watch(call);
    }
  }

  watch(call) {
    const media = call.media = this.createMedia();
    media.on('playback', (next) => {
      this.refresh();
      if (call.media !== media) return;
      if (!next) return this.stopWatching(call);
      if (call.ending && call.paused) return; // native verification completes the pending resume
      if (!call.before) {
        if (next.playing !== true) return this.stopWatching(call);
        call.before = next;
        call.timer = setTimeout(() => this.stopWatching(call), CONFIRM_MS);
        call.timer.unref();
        if (!media.guardPlayback('pause', next.revision)) this.stopWatching(call);
      } else if (call.paused) {
        if (next.revision !== call.paused.revision) this.stopWatching(call);
      } else if (next.revision !== call.before.revision) {
        if (!call.pauseAccepted || next.track !== call.before.track || next.playing !== false) return this.stopWatching(call);
        call.paused = next;
        clearTimeout(call.timer);
        if (call.ending) this.resume(call);
      }
    });
    media.on('guarded', (action, accepted) => {
      if (call.media !== media) return;
      if (action === 'play') this.reset();
      else if (accepted) call.pauseAccepted = true;
      else this.stopWatching(call);
    });
    if (!media.watchMacPlayback(true)) this.stopWatching(call);
  }

  resume(call) {
    call.timer = setTimeout(() => this.stopWatching(call), CONFIRM_MS);
    call.timer.unref();
    if (!call.media.guardPlayback('play', call.paused.revision)) this.stopWatching(call);
  }

  stopWatching(call) {
    const media = call.media;
    call.media = call.paused = null;
    clearTimeout(call.timer);
    if (call.ending && this.call === call) this.call = null;
    if (media) media.watchMacPlayback(false);
  }

  reset() {
    if (this.call) this.stopWatching(this.call);
    this.call = null;
  }
}

module.exports = { CallMedia };
