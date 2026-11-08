// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Ported from Apple's ALAC decoder (https://github.com/macosforge/alac, Apache-2.0; ALACDecoder.cpp,
// ag_dec.c, dp_dec.c, matrix_dec.c), which UxPlay plays AirPlay's music stream with. See
// THIRD_PARTY_NOTICES.
// Apple Lossless, as AirPlay sends it when a device plays music to this computer (the audio-only
// AirPlay of Spotify, Music, YouTube…: stream type 96, ct 2): 16-bit stereo, 352 samples a packet,
// AirPlay's fixed "magic cookie" (frameLength 352, pb 40, mb 10, kb 14, maxRun 255).
//
// const d = new AlacDecoder({frameLength, bitDepth, channels, pb, mb, kb, maxRun});
// d.decode(Uint8Array) → [Float32Array per channel] (samples in -1..1); throws on a broken packet.
// Runs in the AirPlay window (viewer-renderer.js) and in Node (shared/test/airplay-alac.js).
'use strict';

(function (root) {
  const ID_SCE = 0, ID_CPE = 1, ID_CCE = 2, ID_LFE = 3, ID_DSE = 4, ID_PCE = 5, ID_FIL = 6, ID_END = 7;
  const QBSHIFT = 9, QB = 1 << QBSHIFT, MMULSHIFT = 2, MDENSHIFT = QBSHIFT - MMULSHIFT - 1, MOFF = 1 << (MDENSHIFT - 2);
  const BITOFF = 24, MAX_PREFIX_16 = 9, MAX_PREFIX_32 = 9, MAX_DATATYPE_BITS_16 = 16;
  const N_MAX_MEAN_CLAMP = 0xffff, N_MEAN_CLAMP_VAL = 0xffff;

  const lead = (x) => Math.clz32(x);
  const lg3a = (x) => 31 - lead((x + 3) >>> 0);
  const sign = (x) => (x > 0) - (x < 0);

  // Big-endian bits of a packet; reads past the end give zeros (as the C reads its padded buffer).
  class Bits {
    constructor(buf) { this.b = buf; this.pos = 0; this.size = buf.length * 8; }
    byte(i) { return i < this.b.length ? this.b[i] : 0; }
    // 32 bits starting at a byte, big-endian.
    word(i) { return ((this.byte(i) << 24) | (this.byte(i + 1) << 16) | (this.byte(i + 2) << 8) | this.byte(i + 3)) >>> 0; }
    // n (≤ 32) bits from any bit position.
    peekAt(pos, n) {
      let v = 0;
      for (let k = 0; k < n; k++) { const p = pos + k; v = v * 2 + ((this.byte(p >> 3) >> (7 - (p & 7))) & 1); }
      return v >>> 0;
    }
    read(n) { const v = this.peekAt(this.pos, n); this.pos += n; return v; }
    align() { this.pos = (this.pos + 7) & ~7; }
  }

  // ag_dec.c: adaptive Golomb codes.
  const fromLong = (v, k) => (k ? v >>> (32 - k) : 0);

  function dynGet(bits, at, m, k) {
    let p = at.p;
    let s = (bits.word(p >> 3) << (p & 7)) >>> 0;
    let pre = lead(~s >>> 0);
    let result;
    if (pre >= MAX_PREFIX_16) {
      pre = MAX_PREFIX_16;
      p += pre;
      s = (s << pre) >>> 0;
      result = bits.peekAt(p, MAX_DATATYPE_BITS_16);
      p += MAX_DATATYPE_BITS_16;
    } else {
      p += pre + 1;
      s = ((s << (pre + 1)) >>> 0);
      const v = fromLong(s, k);
      p += k;
      result = pre * m + v - 1;
      if (v < 2) { result -= v - 1; p -= 1; }
    }
    at.p = p;
    return result >>> 0;
  }

  function dynGet32(bits, at, m, k, maxbits) {
    let p = at.p;
    let s = (bits.word(p >> 3) << (p & 7)) >>> 0;
    let result = lead(~s >>> 0);
    if (result >= MAX_PREFIX_32) {
      result = bits.peekAt(p + MAX_PREFIX_32, maxbits);
      p += MAX_PREFIX_32 + maxbits;
    } else {
      p += result + 1;
      if (k !== 1) {
        s = (s << (result + 1)) >>> 0;
        const v = fromLong(s, k);
        p += k - 1;
        result *= m;
        if (v >= 2) { result += v - 1; p += 1; }
      }
    }
    at.p = p;
    return result >>> 0;
  }

  function dynDecomp(ag, bits, pc, numSamples, maxSize) {
    const at = { p: bits.pos };
    const maxPos = bits.size;
    const pb = ag.pb, kb = ag.kb, wb = ag.wb;
    let mb = ag.mb0, zmode = 0, c = 0;
    while (c < numSamples) {
      if (at.p >= maxPos) throw new Error('alac: ran past the packet');
      let m = mb >>> QBSHIFT;
      let k = Math.min(lg3a(m), kb);
      m = (1 << k) - 1;
      const n = dynGet32(bits, at, m, k, maxSize);
      const nd = n + zmode;
      pc[c++] = ((nd + 1) >>> 1) * ((nd & 1) ? -1 : 1);
      mb = (pb * (n + zmode) + mb - ((pb * mb) >>> QBSHIFT)) >>> 0;
      if (n > N_MAX_MEAN_CLAMP) mb = N_MEAN_CLAMP_VAL;
      zmode = 0;
      if (((mb << MMULSHIFT) >>> 0) < QB && c < numSamples) {
        zmode = 1;
        const kk = lead(mb) - BITOFF + ((mb + MOFF) >> MDENSHIFT);
        const mz = ((1 << kk) - 1) & wb;
        const run = dynGet(bits, at, mz, kk);
        if (c + run > numSamples) throw new Error('alac: run too long');
        for (let j = 0; j < run; j++) pc[c++] = 0;
        if (run >= 65535) zmode = 0;
        mb = 0;
      }
    }
    bits.pos = at.p;
  }

  // dp_dec.c: the adaptive FIR predictor, undone. coefs is changed as it goes (Int16, as in C).
  function unpcBlock(pc, out, num, coefs, numActive, chanBits, denShift) {
    const cs = 32 - chanBits;
    const wrap = (v) => ((v << cs) >> cs);
    out[0] = pc[0];
    if (numActive === 0) { for (let j = 1; j < num; j++) out[j] = pc[j]; return; }
    if (numActive === 31) {
      let prev = out[0];
      for (let j = 1; j < num; j++) { prev = wrap((pc[j] + prev) | 0); out[j] = prev; }
      return;
    }
    const denHalf = 1 << (denShift - 1);
    for (let j = 1; j <= numActive; j++) out[j] = wrap((pc[j] + out[j - 1]) | 0);
    const lim = numActive + 1;
    const b = new Int32Array(numActive);
    for (let j = lim; j < num; j++) {
      const top = out[j - lim];
      let sum = denHalf;
      for (let k = 0; k < numActive; k++) { b[k] = (top - out[j - 1 - k]) | 0; sum = (sum - Math.imul(coefs[k], b[k])) | 0; }
      let del = pc[j];
      let del0 = del;
      const sg = sign(del);
      del = (del + top + (sum >> denShift)) | 0;
      out[j] = wrap(del);
      if (sg > 0) {
        for (let k = numActive - 1; k >= 0; k--) {
          const sgn = sign(b[k]);
          coefs[k] -= sgn;
          del0 -= (numActive - k) * ((sgn * b[k]) >> denShift);
          if (del0 <= 0) break;
        }
      } else if (sg < 0) {
        for (let k = numActive - 1; k >= 0; k--) {
          const sgn = -sign(b[k]);
          coefs[k] -= sgn;
          del0 -= (numActive - k) * ((sgn * b[k]) >> denShift);
          if (del0 >= 0) break;
        }
      }
    }
  }

  class AlacDecoder {
    constructor(o = {}) {
      this.frameLength = o.frameLength || 352;
      this.bitDepth = o.bitDepth || 16;
      this.channels = o.channels || 2;
      this.pb = o.pb != null ? o.pb : 40;
      this.mb = o.mb != null ? o.mb : 10;
      this.kb = o.kb != null ? o.kb : 14;
      this.maxRun = o.maxRun || 255;
      const n = Math.max(this.frameLength, 4096);
      this.pred = new Int32Array(n);
      this.u = new Int32Array(n);
      this.v = new Int32Array(n);
    }

    _ag(pbFactor) {
      const kb = this.kb;
      return { mb0: this.mb, pb: (this.pb * pbFactor) >> 2, kb, wb: (1 << kb) - 1 };
    }

    // One channel's header (mode, shift, predictor) and its coefficients.
    _side(bits) {
      let h = bits.read(8);
      const mode = h >> 4, denShift = h & 15;
      h = bits.read(8);
      const pbFactor = h >> 5, num = h & 31;
      const coefs = new Int16Array(32);
      for (let i = 0; i < num; i++) coefs[i] = bits.read(16);
      return { mode, denShift, pbFactor, num, coefs };
    }

    _channel(bits, side, numSamples, chanBits, dst) {
      dynDecomp(this._ag(side.pbFactor), bits, this.pred, numSamples, chanBits);
      if (side.mode !== 0) unpcBlock(this.pred, this.pred, numSamples, null, 31, chanBits, 0);
      unpcBlock(this.pred, dst, numSamples, side.coefs, side.num, chanBits, side.denShift);
    }

    decode(buf) {
      const bits = new Bits(buf);
      const out = [];
      const scale = 1 / (1 << (this.bitDepth - 1));
      for (let guard = 0; guard < 16; guard++) {
        if (bits.pos + 3 > bits.size) break;
        const tag = bits.read(3);
        if (tag === ID_END) { bits.align(); break; }
        if (tag === ID_SCE || tag === ID_LFE || tag === ID_CPE) {
          const stereo = tag === ID_CPE;
          bits.read(4); // element instance tag
          if (bits.read(12) !== 0) throw new Error('alac: bad header');
          const hb = bits.read(4);
          const partial = hb >> 3, shifted = (hb >> 1) & 3, escape = hb & 1;
          if (shifted) throw new Error('alac: shifted samples (only 16-bit is supported)');
          let numSamples = this.frameLength;
          if (partial) numSamples = bits.read(16) * 65536 + bits.read(16);
          if (numSamples > this.u.length) throw new Error('alac: frame too long');
          const chanBits = this.bitDepth + (stereo ? 1 : 0);
          let mixBits = 0, mixRes = 0;
          if (!escape) {
            if (stereo) { mixBits = bits.read(8); mixRes = (bits.read(8) << 24) >> 24; }
            else { bits.read(8); bits.read(8); }
            const su = this._side(bits);
            const sv = stereo ? this._side(bits) : null;
            this._channel(bits, su, numSamples, chanBits, this.u);
            if (stereo) this._channel(bits, sv, numSamples, chanBits, this.v);
          } else {
            const sh = 32 - this.bitDepth;
            for (let i = 0; i < numSamples; i++) {
              this.u[i] = (bits.read(this.bitDepth) << sh) >> sh;
              if (stereo) this.v[i] = (bits.read(this.bitDepth) << sh) >> sh;
            }
          }
          const L = new Float32Array(numSamples);
          if (!stereo) {
            for (let i = 0; i < numSamples; i++) L[i] = this.u[i] * scale;
            out.push(L);
            continue;
          }
          const R = new Float32Array(numSamples);
          // matrix_dec.c unmix16
          for (let i = 0; i < numSamples; i++) {
            const u = this.u[i], v = this.v[i];
            let l, r;
            if (mixRes !== 0) { l = (u + v - ((mixRes * v) >> mixBits)) | 0; r = l - v; } else { l = u; r = v; }
            L[i] = Math.max(-32768, Math.min(32767, (l << 16) >> 16)) * scale;
            R[i] = Math.max(-32768, Math.min(32767, (r << 16) >> 16)) * scale;
          }
          out.push(L, R);
        } else if (tag === ID_DSE) {
          bits.read(4);
          const align = bits.read(1);
          let count = bits.read(8);
          if (count === 255) count += bits.read(8);
          if (align) bits.align();
          bits.pos += count * 8;
        } else if (tag === ID_FIL) {
          let count = bits.read(4);
          if (count === 15) count += bits.read(8) - 1;
          bits.pos += count * 8;
        } else {
          throw new Error(`alac: element ${tag} not supported`);
        }
        if (out.length >= this.channels) {
          // What's left must be the END tag: a check that the packet decoded in step.
          if (bits.pos + 3 <= bits.size && bits.peekAt(bits.pos, 3) !== ID_END) throw new Error('alac: out of step');
          break;
        }
      }
      if (!out.length) throw new Error('alac: no audio in the packet');
      return out;
    }
  }

  const api = { AlacDecoder };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Alac = api;
})(typeof self !== 'undefined' ? self : this);
