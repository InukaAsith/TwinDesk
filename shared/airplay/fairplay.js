// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Adapted from UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0), lib/fairplay_playfair.c; playfair
// by EstebanKubata (https://github.com/EstebanKubata/playfair), as UxPlay ships it.
// FairPlay for the AirPlay receiver: the /fp-setup answers, and the SETUP's ekey unwrapped into the
// session's AES key with playfair (UxPlay lib/playfair, built to playfair.wasm by playfair/build.sh).
//
// new FairPlay(); .setup(body) → Buffer reply | null (each /fp-setup); .decrypt(ekey) → 16-byte key.
'use strict';

const fs = require('fs');
const path = require('path');
const REPLIES = require('./fp-replies.js').map((b) => Buffer.from(b, 'base64'));

// UxPlay lib/fairplay_playfair.c: the 12 bytes before the last 20 of the second message.
const FP_HEADER = Buffer.from([0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00, 0x14]);

let wasm = null;
function engine() {
  if (wasm) return wasm;
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'playfair.wasm')));
  const inst = new WebAssembly.Instance(mod, {});
  wasm = { mem: inst.exports.memory, io: inst.exports.td_io(), decrypt: inst.exports.td_decrypt };
  return wasm;
}

class FairPlay {
  constructor() { this.keyMsg = null; }

  setup(body) {
    if (!Buffer.isBuffer(body) || body.length < 16 || body[4] !== 0x03) return null;
    if (body.length === 16) {
      const mode = body[14];
      return REPLIES[mode] ? Buffer.from(REPLIES[mode]) : null;
    }
    if (body.length === 164 && body[12] <= 3) { // [12]: the mode playfair's tables are picked by
      this.keyMsg = Buffer.from(body);
      return Buffer.concat([FP_HEADER, body.subarray(144, 164)]);
    }
    return null;
  }

  decrypt(ekey) {
    if (!this.keyMsg) throw new Error('FairPlay setup not done');
    if (!Buffer.isBuffer(ekey) || ekey.length !== 72) throw new Error('bad ekey');
    const w = engine();
    const io = new Uint8Array(w.mem.buffer, w.io, 164 + 72 + 16);
    io.set(this.keyMsg, 0);
    io.set(ekey, 164);
    w.decrypt();
    return Buffer.from(new Uint8Array(w.mem.buffer, w.io + 236, 16));
  }
}

module.exports = { FairPlay };
