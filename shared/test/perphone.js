// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/perphone.js: one Now Playing per phone, made only while Media controls is on; the
// Overview's controls and view are the active phone's; turning it on reaches every phone.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { PerPhone, phoneMedia } = require('../perphone.js');
const { NowPlaying } = require('../nowplaying.js');
const P = require('../protocol.js');

// A phone's scoped link (mesh/phone-link.js): its events and what it was sent.
function link(os) {
  const l = new EventEmitter();
  l.current = { os, deviceId: 'd-' + Math.random() };
  l.sent = [];
  l.sendToClient = (m) => l.sent.push(m);
  return l;
}

// PerPhone: made once per unit, nothing while not wanted.
{
  let want = false;
  let made = 0;
  const set = new PerPhone(() => ({ n: ++made }), { want: () => want });
  const u = { link: link(P.OS.ANDROID) };
  assert.strictEqual(set.unit(u), null);
  want = true;
  const a = set.unit(u);
  assert.strictEqual(set.unit(u), a);
  assert.strictEqual(made, 1);
  assert.strictEqual(set.of({}), null);
}

// phoneMedia: off → nothing asked; on → every phone asked; controls go to the active phone only.
{
  const audio = { phoneMedia: false };
  const a = { link: link(P.OS.ANDROID) };
  const b = { link: link(P.OS.ANDROID) };
  const phones = { all: [a, b], active: b };
  let changes = 0;
  const np = phoneMedia({ NowPlaying, cfg: () => audio, onChange: () => changes++, phones: () => phones });
  np.unit(a);
  np.unit(b);
  assert.strictEqual(np.view, null);
  assert.strictEqual(a.link.sent.length, 0);

  audio.phoneMedia = true;
  np.apply();
  for (const u of [a, b]) assert.ok(u.link.sent.some((m) => m.t === P.T.PHONE_MEDIA_WANT && m.on === true));
  assert.ok(np.view && np.view.on === true);

  np.control('next');
  assert.ok(b.link.sent.some((m) => m.t === P.T.PHONE_MEDIA_CTL && m.a === 'next'));
  assert.ok(!a.link.sent.some((m) => m.t === P.T.PHONE_MEDIA_CTL));

  // What b plays is the view; a's isn't.
  a.link.emit(`t:${P.T.PHONE_MEDIA}`, { app: 'x', title: 'A song', playing: true }, a.link.current);
  assert.strictEqual(np.view.now, null);
  b.link.emit(`t:${P.T.PHONE_MEDIA}`, { app: 'y', title: 'B song', playing: true }, b.link.current);
  assert.strictEqual(np.view.now.title, 'B song');
  assert.ok(changes > 0);

  // Off: each one is told.
  audio.phoneMedia = false;
  np.apply();
  for (const u of [a, b]) assert.ok(u.link.sent.some((m) => m.t === P.T.PHONE_MEDIA_WANT && m.on === false));
}

// phoneRemote: off → a phone's Remote page hears it's off; on → one per phone, the view the active one's.
{
  const { phoneRemote } = require('../perphone.js');
  let allow = false;
  const made = [];
  class FakeRemote {
    constructor(o) { this.server = o.server; this.allow = null; made.push(this); }
    refresh() {}
    setAllow(on) { this.allow = on; }
    setPad(on) { this.pad = on; }
    get view() { return { allow: this.allow, who: this.server.current.deviceId }; }
  }
  const a = { link: link(P.OS.ANDROID) };
  const b = { link: link(P.OS.ANDROID) };
  const phones = { all: [a, b], active: b };
  const rem = phoneRemote({ PhoneRemote: FakeRemote, opts: {}, wanted: () => allow, phones: () => phones });
  rem.unit(a);
  rem.unit(b);
  assert.strictEqual(made.length, 0);
  a.link.emit(`t:${P.T.REMOTE_HELLO}`, {});
  assert.ok(a.link.sent.some((m) => m.t === P.T.REMOTE_STATE && m.off === true));
  allow = true;
  assert.strictEqual(rem.load(), true);
  assert.strictEqual(made.length, 2);
  rem.setAllow(true);
  assert.ok(made.every((r) => r.allow === true));
  assert.strictEqual(rem.view.who, b.link.current.deviceId);
  rem.setPad(true);
  assert.strictEqual(made.find((r) => r.server === b.link).pad, true);
  assert.strictEqual(made.find((r) => r.server === a.link).pad, undefined);
  // On now: no "off" answer any more.
  const before = a.link.sent.length;
  a.link.emit(`t:${P.T.REMOTE_HELLO}`, {});
  assert.strictEqual(a.link.sent.length, before);
}

// anyPhone: one iPhone at a time, held until it leaves; another iPhone isn't heard meanwhile.
{
  const { anyPhone } = require('../perphone.js');
  const any = anyPhone({ want: (c) => c.os === P.OS.IOS });
  const heard = [];
  let welcomes = 0;
  let closes = 0;
  any.link.on('welcome', () => welcomes++);
  any.link.on('closed', () => closes++);
  any.link.on('ios.sign', (m) => heard.push(m.n));
  const droid = { link: link(P.OS.ANDROID) };
  any.unit(droid);
  assert.strictEqual(any.link.current, null); // not an iPhone
  const a = { link: link(P.OS.IOS) };
  any.unit(a); // already connected: held at once
  assert.strictEqual(welcomes, 1);
  assert.strictEqual(any.link.current, a.link.current);
  const b = { link: link(P.OS.IOS) };
  any.unit(b);
  b.link.emit('client', b.link.current);
  assert.strictEqual(welcomes, 1); // a still has it
  b.link.emit('t:ios.sign', { n: 2 });
  a.link.emit('t:ios.sign', { n: 1 });
  assert.deepStrictEqual(heard, [1]);
  any.link.send({ t: 'x' });
  assert.ok(a.link.sent.some((m) => m.t === 'x') && !b.link.sent.some((m) => m.t === 'x'));
  const bWas = b.link.current;
  b.link.current = null;
  b.link.emit('closed');
  assert.strictEqual(closes, 0); // not the one in use
  b.link.current = bWas; // b comes back while a still has it
  b.link.emit('client', bWas);
  assert.strictEqual(welcomes, 1);
  // a leaves: closed, then b (still there) takes over from the start.
  a.link.emit('closed');
  assert.strictEqual(closes, 1);
  assert.strictEqual(welcomes, 2);
  assert.strictEqual(any.link.current, b.link.current);
  b.link.emit('t:ios.sign', { n: 3 });
  assert.deepStrictEqual(heard, [1, 3]);
}

console.log('perphone: ok');
