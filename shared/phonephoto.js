// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera › Take a photo with the phone (Mac, Windows, Linux; an Android phone): the phone's own
// camera app opens (cam.capture, the phone's CaptureActivity.kt, as Explorer's Capture from phone
// on Windows), the photo taken comes here as a received file, and it's put on the clipboard as a
// picture, ready to paste into a document or a chat. One photo: the camera closes after it.
// The file stays where received files go. Nothing runs between: no timer, it's looked at when a
// batch of files arrives.
//
//   const pp = new PhonePhoto({ send, phoneOn, popup, copy });
//   pp.take();  on every received batch: pp.arrived(placed) → true when it was the photo
//   on the phone's cam.capture {on: false}: pp.ended()
'use strict';

const path = require('path');

const WAIT_MS = 5 * 60000; // the camera open this long at most, for one photo
const PICTURE = /\.(jpe?g|png|webp|heic|heif)$/i;

class PhonePhoto {
  // send(msg) to the phone; phoneOn() → an Android phone is connected; popup(key, vars);
  // copy(file) → Promise: the picture on the clipboard.
  constructor({ send, phoneOn, popup = () => {}, copy, now = Date.now }) {
    Object.assign(this, { send, phoneOn, popup, copy, now });
    this.until = 0;
  }

  get waiting() { return !!this.until && this.now() < this.until; }

  take() {
    if (!this.phoneOn()) { this.popup('Connect your phone'); return false; }
    this.until = this.now() + WAIT_MS;
    this.send({ t: 'cam.capture', on: true, once: true }); // once: the phone closes its camera after the photo (older phones: on: false below)
    this.popup('Take the photo on your phone');
    return true;
  }

  // A batch of received files: the first picture in it, while waiting, is the photo.
  arrived(placed) {
    if (!this.waiting) { this.until = 0; return false; }
    const file = (placed || []).find((p) => typeof p === 'string' && PICTURE.test(p));
    if (!file) return false;
    this.until = 0;
    if (this.phoneOn()) this.send({ t: 'cam.capture', on: false }); // one photo: the camera closes
    Promise.resolve().then(() => this.copy(file))
      .then(() => this.popup('Photo copied, ready to paste', { name: path.basename(file) }))
      .catch((e) => this.popup('Photo saved, not copied: {error}', { error: e.message }));
    return true;
  }

  // The phone's camera closed without a photo (Back), or the phone went.
  ended() { this.until = 0; }

  view() { return { waiting: this.waiting }; }
}

// The picture onto the clipboard (electron: {clipboard, nativeImage}).
function copyPicture(electron, file) {
  const fs = require('fs');
  const { writeClipImage } = require('./clipimage.js');
  const buf = fs.readFileSync(file);
  const img = electron.nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return Promise.reject(new Error('not a picture this computer reads'));
  return writeClipImage(electron.clipboard, img, /\.png$/i.test(file) ? buf : img.toPNG());
}

module.exports = { PhonePhoto, copyPicture, WAIT_MS };
