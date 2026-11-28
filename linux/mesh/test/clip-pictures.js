// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device clipboard (mesh/clip.js), instant mode: a picture copied after another picture has the
// same formats on the clipboard, so the formats alone never saw it. The helper's copy event (Windows'
// ClipWatch.cs) says so; without a helper the picture is looked at again every 3 s.
// Run with: node linux/mesh/test/clip-pictures.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Clip = require('../clip.js');

function make() {
  const clipboard = {
    types: ['image/png'],
    readText: () => '',
    availableFormats() { return this.types; },
    readBuffer: () => Buffer.alloc(0),
  };
  const bus = { on() {}, onPeer() {}, send: () => true, selectedId: () => null, connectedIds: () => ['A'] };
  const mesh = { selfId: 'me', peers: () => [], get: () => ({ id: 'A', name: 'PC-A' }) };
  const settings = { enabled: true, send: true, receive: true, images: true, mode: 'switch', historySize: 20, maxKB: 256, skipConcealed: true };
  const clip = new Clip({ bus, mesh, getSettings: () => settings, onChange: () => {}, clipboard });
  let looks = 0;
  clip.sendIfChanged = async () => { looks++; };
  clip.seen = '';
  clip.formats = 'image/png';
  return { clip, clipboard, looks: () => looks };
}

(async () => {
  // With the helper: each copy is looked at, a picture after a picture too; nothing copied, nothing.
  {
    const { clip, looks } = make();
    const helper = new EventEmitter();
    clip.useHelper(helper);
    await clip.pollOnce();
    assert.strictEqual(looks(), 0, 'the same formats, no copy');
    helper.emit('event', 'clipboard', { seq: 2 });
    await clip.pollOnce();
    assert.strictEqual(looks(), 1, 'a picture copied after a picture');
    for (let i = 0; i < 8; i++) await clip.pollOnce();
    assert.strictEqual(looks(), 1, 'the helper is watching: no looking every 3 s');
    helper.emit('exit');
    assert.strictEqual(clip.watched, false);
  }

  // Formats that change still count; without a helper, a picture is looked at every 3 s while one
  // can go (offerClipboard sends each picture once).
  {
    const { clip, clipboard, looks } = make();
    clipboard.types = ['text/html', 'image/png'];
    await clip.pollOnce();
    assert.strictEqual(looks(), 1, 'new formats');
    let can = true;
    Object.defineProperty(clip.images, 'canSend', { get: () => can });
    for (let i = 0; i < 6; i++) await clip.pollOnce();
    assert.strictEqual(looks(), 2, 'every sixth poll');
    can = false;
    for (let i = 0; i < 12; i++) await clip.pollOnce();
    assert.strictEqual(looks(), 2, 'nobody takes pictures: not every 3 s');
  }

  // The Pictures hint: the connected devices that take our clipboard but not pictures.
  {
    const { clip } = make();
    assert.deepStrictEqual(clip.view.noPictures, ['PC-A']);
    clip.images.policy({ images: true }, 'A');
    assert.deepStrictEqual(clip.view.noPictures, []);
  }

  console.log('clip-pictures: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
