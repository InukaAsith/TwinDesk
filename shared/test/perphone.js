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

console.log('perphone: ok');
