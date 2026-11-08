// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/airplay/alac.js: AirPlay's music stream (ALAC, 16-bit stereo, 352 samples a packet).
//   - an uncompressed ("escape") frame built here comes back sample for sample
//   - packets an iPad sent (the quiet start of a song: compressed frames, with a run of zeros and
//     then small samples) decode in step to their END tag, to the values they decoded to when the
//     whole song (1,928 packets) was checked by ear and by its smoothness
//   - a cut-off packet throws instead of returning noise
'use strict';

const assert = require('assert');
const { AlacDecoder } = require('../airplay/alac.js');

// Bits, most significant first.
function writer() {
  const bits = [];
  return {
    put(v, n) { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); },
    bytes() { const out = Buffer.alloc(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); }); return out; },
  };
}

// An escape frame: CPE, instance 0, 12 zero bits, header (partial 0, shift 0, escape 1), then
// L and R as 16-bit samples, then END.
{
  const n = 352;
  const L = Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 7) * 12000));
  const R = Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 1) * (i * 91 % 32767));
  const w = writer();
  w.put(1, 3); w.put(0, 4); w.put(0, 12); w.put(0b0001, 4);
  for (let i = 0; i < n; i++) { w.put(L[i] & 0xffff, 16); w.put(R[i] & 0xffff, 16); }
  w.put(7, 3);
  const [l, r] = new AlacDecoder().decode(w.bytes());
  assert.strictEqual(l.length, n);
  for (let i = 0; i < n; i++) {
    assert.strictEqual(Math.round(l[i] * 32768), L[i], `L[${i}]`);
    assert.strictEqual(Math.round(r[i] * 32768), R[i], `R[${i}]`);
  }
}

// Compressed frames from an iPad (iPadOS 27, Spotify), in order: one decoder, as in a session.
{
  const d = new AlacDecoder();
  const packets = [
    ['IAAABAATCAmB+MH/gAAAEwgJgfjB/4AAAP+Ar7/gK/w=', 0, 0, 0],
    ['IAAABAATCAmB+MH/gAAAEwgJgfjB/4AAAP+Ar7/gK/w=', 0, 0, 0],
    ['IAAABAATCAmB+MH/gAAAEwgJgfjB/4AAAP+AoE4iIiIiIiIiIiXXh6z/gKBT7b1+bbbboZhQsTfA', 481, 463, 30],
  ];
  for (const [b64, sumL, sumR, peak] of packets) {
    const [l, r] = d.decode(Buffer.from(b64, 'base64'));
    assert.strictEqual(l.length, 352);
    let sl = 0, sr = 0, pk = 0;
    for (let i = 0; i < 352; i++) {
      const a = Math.round(l[i] * 32768), b = Math.round(r[i] * 32768);
      sl += a; sr += b; pk = Math.max(pk, Math.abs(a), Math.abs(b));
    }
    assert.deepStrictEqual([sl, sr, pk], [sumL, sumR, peak]);
  }
  // Cut short: it can't end in step.
  const cut = Buffer.from(packets[2][0], 'base64').subarray(0, 20);
  assert.throws(() => d.decode(cut));
}

console.log('airplay-alac: ok');
