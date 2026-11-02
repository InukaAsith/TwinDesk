// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// linux/wlclip.js with wl-paste / wl-copy faked: when it's used (#97), and the clipboard calls
// clip.js, fclip.js, clipimage.js and eclip.js make through it.
// Run with: node shared/test/wlclip.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { wlClipboard, wanted } = require('../../linux/wlclip.js');
const eclip = require('../eclip.js');

// Used on Wayland only, not on GNOME (no data-control), only with wl-clipboard installed.
const has = () => true;
assert.strictEqual(wanted({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'Hyprland' }, has), true);
assert.strictEqual(wanted({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' }, has), true);
assert.strictEqual(wanted({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, has), false, 'GNOME');
assert.strictEqual(wanted({ DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }, has), false, 'X11');
assert.strictEqual(wanted({ WAYLAND_DISPLAY: 'wayland-1' }, () => false), false, 'not installed');

// A fake wl-clipboard: `board` is the compositor's clipboard (type → Buffer).
const board = new Map();
const run = (cmd, args, opts, cb) => {
  assert.strictEqual(cmd, 'wl-paste');
  if (args[0] === '--list-types') return cb(null, Buffer.from([...board.keys()].join('\n') + (board.size ? '\n' : '')));
  const type = args[args.indexOf('--type') + 1];
  const want = type === 'text' ? [...board.keys()].find((t) => t.startsWith('text/plain')) : type;
  if (!want || !board.has(want)) return cb(Object.assign(new Error('Nothing is copied'), { code: 1 }));
  return cb(null, board.get(want));
};
const start = (cmd, args) => {
  assert.strictEqual(cmd, 'wl-copy');
  const p = new EventEmitter();
  const chunks = [];
  p.stdin = Object.assign(new EventEmitter(), { end: (d) => { chunks.push(Buffer.from(d)); board.clear(); board.set(args[1], Buffer.concat(chunks)); } });
  setImmediate(() => p.emit('spawn'));
  return p;
};
const nativeImage = { createEmpty: () => ({ isEmpty: () => true }), createFromBuffer: (b) => ({ isEmpty: () => !b.length, png: b }) };
const cb = wlClipboard({ run, start, nativeImage });

(async () => {
  assert.strictEqual(await cb.readText(), '', 'empty clipboard: no text, no error');
  assert.deepStrictEqual(await cb.availableFormats(), []);

  // Another app copies text: it's seen (Electron's wasn't); ours reaches the other apps.
  board.set('text/plain;charset=utf-8', Buffer.from('from another app'));
  assert.strictEqual(await cb.readText(), 'from another app');
  await cb.writeText('from the Mac ✓');
  assert.strictEqual(board.get('text/plain;charset=utf-8').toString('utf8'), 'from the Mac ✓');

  // KeePassXC's secret: concealed, through eclip as on every platform.
  board.clear();
  board.set('text/plain;charset=utf-8', Buffer.from('hunter2'));
  board.set('x-kde-passwordManagerHint', Buffer.from('secret'));
  assert.strictEqual(await eclip.isConcealed(cb), true, 'a password manager’s copy');
  board.delete('x-kde-passwordManagerHint');
  assert.strictEqual(await eclip.isConcealed(cb), false);

  // Pictures: read when there is a PNG, written as one.
  assert.strictEqual((await cb.readImage()).isEmpty(), true, 'no picture');
  board.clear();
  board.set('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.strictEqual((await cb.readImage()).isEmpty(), false);
  assert.strictEqual(await eclip.hasImage(cb), true);
  await cb.writeImage({ toPNG: () => Buffer.from('png!') });
  assert.strictEqual(board.get('image/png').toString(), 'png!');

  // A file manager's copied files (fclip.js).
  board.clear();
  board.set('x-special/gnome-copied-files', Buffer.from('copy\nfile:///home/a.txt'));
  const s = await eclip.snapshot(cb);
  assert.strictEqual((await s.raw('x-special/gnome-copied-files')).toString(), 'copy\nfile:///home/a.txt');
  assert.strictEqual((await s.raw('text/uri-list')).length, 0, 'absent: empty');

  console.log('wlclip: ok');
})().catch((e) => { console.error(e); process.exit(1); });
