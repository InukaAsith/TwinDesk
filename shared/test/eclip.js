// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/eclip.js: the clipboard's formats, a picture on it and a password manager's secret, the
// same through Electron before 44 (availableFormats/readBuffer) and from 44 (read() of ClipboardItems).
// Run with: node shared/test/eclip.js
'use strict';

const assert = require('assert');
const eclip = require('../eclip.js');

// Electron 44: read() → items with types and getType(type) → a Blob.
function modern(entries) {
  return {
    read: async () => [{ types: Object.keys(entries), getType: async (t) => new Blob([entries[t]]) }],
    readText: async () => '',
  };
}
// Before 44: the format names as they were, and readBuffer (empty when absent).
function legacy(entries) {
  return {
    availableFormats: () => Object.keys(entries),
    readBuffer: (f) => (entries[f] ? Buffer.from(entries[f]) : Buffer.alloc(0)),
  };
}
const raw = eclip.RAW;

(async () => {
  // Plain text: nothing concealed, no picture, on both.
  for (const cb of [modern({ 'text/plain': 'hi' }), legacy({ 'text/plain': 'hi' })]) {
    assert.deepStrictEqual(await eclip.formats(cb), ['text/plain']);
    assert.strictEqual(await eclip.hasImage(cb), false);
    assert.strictEqual(await eclip.isConcealed(cb), false);
  }

  // A picture.
  assert.strictEqual(await eclip.hasImage(modern({ 'image/png': 'x' })), true);
  assert.strictEqual(await eclip.hasImage(legacy({ 'image/png': 'x' })), true);

  // A password manager's marker: an OS format, which 44 names `electron application/osclipboard;format="…"`.
  const marker = 'ExcludeClipboardContentFromMonitorProcessing';
  assert.strictEqual(await eclip.isConcealed(modern({ 'text/plain': 'pw', [raw(marker)]: '\u0000' })), true);
  assert.strictEqual(await eclip.isConcealed(legacy({ 'text/plain': 'pw', [marker]: '\u0000' })), true);
  // … listed by its bare name, as availableFormats gave it.
  assert.deepStrictEqual(await eclip.formats(modern({ 'text/plain': 'pw', [raw(marker)]: '\u0000' })), ['text/plain', marker]);

  // Windows' history opt-out: CanIncludeInClipboardHistory = 0 is a secret, 1 isn't.
  const hist = 'CanIncludeInClipboardHistory';
  const dword = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  assert.strictEqual(await eclip.isConcealed(modern({ 'text/plain': 'pw', [raw(hist)]: dword(0) })), true);
  assert.strictEqual(await eclip.isConcealed(modern({ 'text/plain': 'ok', [raw(hist)]: dword(1) })), false);

  // A MIME format read by name (Linux file managers' text/uri-list).
  const s = await eclip.snapshot(modern({ 'text/uri-list': 'file:///home/a.txt\r\n' }));
  assert.strictEqual((await s.raw('text/uri-list')).toString('utf8'), 'file:///home/a.txt\r\n');
  assert.strictEqual((await s.raw('x-special/gnome-copied-files')).length, 0, 'absent: empty');

  // A clipboard that can't be read (another app holds it): empty, never a throw.
  const locked = { read: async () => { throw new Error('busy'); } };
  assert.deepStrictEqual(await eclip.formats(locked), []);
  assert.strictEqual(await eclip.isConcealed(locked), false);

  // A test fake with readBuffer only (the mesh tests'): taken as the old API.
  assert.strictEqual(await eclip.isConcealed({ readBuffer: () => Buffer.alloc(0) }), false);

  console.log('eclip: ok');
})().catch((e) => { console.error(e); process.exit(1); });
