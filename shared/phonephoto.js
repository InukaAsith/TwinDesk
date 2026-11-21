// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera › Take a photo with the phone, and Camera › Scan document (Mac, Windows, Linux, one-to-one
// and Multi-device; an Android phone). The phone's own camera app opens (cam.capture, the phone's
// CaptureActivity.kt). A photo comes back as a received picture and is put on the clipboard. A scan
// comes back as a received PDF and stays with received files: it is not copied as a picture.
// One photo: the camera closes after it. A scan stays open on the phone until the PDF is sent, or
// until Back. Nothing runs between: no timer, it's looked at when a batch of files arrives.
//
//   const pp = new PhonePhoto({ send, phoneOn, popup, copy });
//   pp.take(); pp.scan();  on every received batch: pp.arrived(placed) → true when it was the photo or the PDF
//   on the phone's cam.capture {on: false}, or when the phone is gone: pp.ended()
'use strict';

const path = require('path');

const WAIT_MS = 5 * 60000; // the camera stays open this long at most
const PICTURE = /\.(jpe?g|png|webp|heic|heif)$/i;
const PDF = /\.pdf$/i;

class PhonePhoto {
  // send(msg) to the phone; phoneOn() → an Android phone is connected; popup(key, vars);
  // copy(file) → Promise: the picture on the clipboard. A scan never calls copy.
  constructor({ send, phoneOn, popup = () => {}, copy, now = Date.now }) {
    Object.assign(this, { send, phoneOn, popup, copy, now });
    this.until = 0;
    this.mode = ''; // 'photo' | 'scan' while waiting, '' otherwise
  }

  get waiting() { return !!this.until && this.now() < this.until; }

  take() { return this._begin('photo'); }

  scan() { return this._begin('scan'); }

  // A new request replaces one that is still waiting, and tells the phone to close the camera it had open.
  _begin(mode) {
    if (!this.phoneOn()) { this.popup('Connect your phone'); return false; }
    const restart = this.waiting;
    this.mode = mode;
    this.until = this.now() + WAIT_MS;
    if (restart) this.send({ t: 'cam.capture', on: false });
    if (mode === 'scan') {
      this.send({ t: 'cam.capture', on: true, mode: 'scan' }); // older phones ignore mode and take a normal photo
      this.popup('Scan the document on your phone');
    } else {
      this.send({ t: 'cam.capture', on: true, once: true }); // once: the phone closes its camera after the photo (older phones: on: false below)
      this.popup('Take the photo on your phone');
    }
    return true;
  }

  // A batch of received files. While waiting for a photo, the first picture is it. While waiting for
  // a scan, the first PDF is it (a picture is left for the normal received-files notice). The file
  // already went through received files; true only skips that generic notice.
  arrived(placed) {
    if (!this.waiting) { this.until = 0; this.mode = ''; return false; }
    const scan = this.mode === 'scan';
    const file = (placed || []).find((p) => typeof p === 'string' && (scan ? PDF : PICTURE).test(p));
    if (!file) return false;
    this.until = 0;
    this.mode = '';
    if (this.phoneOn()) this.send({ t: 'cam.capture', on: false }); // the phone's camera closes
    if (scan) {
      this.popup('Document scan saved: {name}', { name: path.basename(file) });
      return true;
    }
    Promise.resolve().then(() => this.copy(file))
      .then(() => this.popup('Photo copied, ready to paste', { name: path.basename(file) }))
      .catch((e) => this.popup('Photo saved, not copied: {error}', { error: e.message }));
    return true;
  }

  // The phone's camera closed without a photo or a PDF (Back), or the phone went.
  ended() { this.until = 0; this.mode = ''; }

  view() { return { waiting: this.waiting, mode: this.waiting ? this.mode : '' }; }
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
