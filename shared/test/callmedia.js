// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CallMedia } = require('../callmedia.js');
const { PhoneHub } = require('../phonehub.js');
const P = require('../protocol.js');

const phone = (deviceId = 'phone') => ({ deviceId, authed: true, os: P.OS.ANDROID, ws: { readyState: 1 } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Media extends EventEmitter {
  constructor(playing, acceptPause, delayPause) {
    super();
    this.next = { playing, track: 1, revision: 1 };
    this.acceptPause = acceptPause;
    this.delayPause = delayPause;
    this.commands = [];
  }

  watchMacPlayback(on) {
    this.watching = on;
    if (on) queueMicrotask(() => this.publish());
    return on;
  }

  publish() {
    if (this.watching) this.emit('playback', this.next);
  }

  change(playing, track = this.next.track) {
    this.next = { playing, track, revision: this.next.revision + 1 };
    this.publish();
  }

  guardPlayback(action, revision) {
    queueMicrotask(() => {
      if (!this.watching) return;
      const accepted = this.next.revision === revision && (action === 'play' || this.acceptPause);
      if (accepted) this.commands.push(action);
      this.emit('guarded', action, accepted);
      if (accepted && (action === 'play' || !this.delayPause)) this.change(action === 'play');
    });
    return true;
  }
}

function fixture({ enabled = true, playing = true, acceptPause = true, delayPause = false } = {}) {
  const server = new EventEmitter();
  const session = server.current = phone();
  server.sendToClient = () => {};
  const settings = { hub: { calls: true } };
  if (enabled !== null) settings.hub.callPause = enabled;
  const hub = new PhoneHub({ server, getSettings: () => settings, save: () => {} });
  const media = new Media(playing, acceptPause, delayPause);
  new CallMedia(hub, () => media);
  return {
    server, session, hub, media,
    state: (state, ctx = session, ws = ctx.ws) => server.emit(`t:${P.T.CALL_STATE}`, { state }, ctx, ws),
    disconnect() {
      server.current = null;
      session.ws.readyState = 3;
      server.emit('closed', session);
    },
  };
}

async function pausesAndResumes() {
  for (const start of ['ringing', 'offhook']) {
    const { state, media, session } = fixture();
    state(start);
    await tick();
    state('offhook');
    assert.deepEqual(media.commands, ['pause'], `one pause starting at ${start}`);
    assert.equal(media.next.playing, false);
    state('idle', phone('another phone'));
    state('idle', phone(session.deviceId));
    session.alt = { readyState: 1 };
    state('idle', session, session.alt);
    await tick();
    assert.deepEqual(media.commands, ['pause'], 'an idle from another device or socket cannot resume');
    state('idle');
    await tick();
    assert.deepEqual(media.commands, ['pause', 'play'], 'the original socket can end the call');
    assert.equal(media.watching, false);
  }

  const short = fixture({ delayPause: true });
  short.state('ringing');
  await tick();
  short.state('idle');
  short.media.change(false);
  await tick();
  assert.deepEqual(short.media.commands, ['pause', 'play'], 'an accepted pause can settle after a short call ends');
}

async function preservesPlaybackDecisions() {
  for (const [options, reason] of [
    [{ enabled: null }, 'a missing preference is disabled by default'],
    [{ enabled: false }, 'an explicitly disabled preference stays off'],
    [{ playing: false }, 'already paused'],
    [{ acceptPause: false }, 'the player rejected pause'],
  ]) {
    const { state, media } = fixture(options);
    state('ringing');
    await tick();
    state('idle');
    await tick();
    assert.deepEqual(media.commands, [], reason);
    assert.ok(!media.watching, reason);
  }

  const ended = fixture();
  ended.state('ringing');
  ended.state('idle');
  await tick();
  assert.deepEqual(ended.media.commands, [], 'a call ending during startup cannot pause afterwards');

  for (const [invalidate, reason] of [
    [(f) => f.disconnect(), 'unexpected disconnect'],
    [(f) => {
      f.hub.act({ do: 'opt', callPause: false });
      f.hub.act({ do: 'opt', callPause: true });
      f.state('offhook');
    }, 'setting switched off and back on'],
    [(f) => f.media.change(true), 'manual resume'],
    [(f) => { f.media.change(true); f.media.change(false); }, 'manual resume followed by another pause'],
    [(f) => f.media.change(false, 2), 'different media item'],
    [(f) => f.media.change(false), 'playback changed while paused'],
    [(f) => {
      const replacement = f.server.current = phone(f.session.deviceId);
      f.server.emit('client', replacement);
      f.state('idle', replacement);
    }, 'same device reconnects on a new socket'],
    [(f) => {
      const replacement = f.server.current = phone('another phone');
      f.server.emit('client', replacement);
      f.state('idle', replacement);
    }, 'another phone replaces the original'],
    [(f) => {
      f.state('idle');
      f.disconnect();
    }, 'disconnect while the resume check is pending'],
  ]) {
    const f = fixture();
    f.state('ringing');
    await tick();
    assert.deepEqual(f.media.commands, ['pause']);
    invalidate(f);
    f.state('idle');
    await tick();
    assert.deepEqual(f.media.commands, ['pause'], reason);
    assert.equal(f.media.watching, false, reason);
  }
}

(async () => {
  await pausesAndResumes();
  await preservesPlaybackDecisions();
  console.log('callmedia: ringing, offhook, guarded resume, opt-in, playback changes and socket isolation passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
