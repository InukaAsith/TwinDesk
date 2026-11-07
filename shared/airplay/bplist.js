// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Binary property lists (bplist00), the body of most AirPlay requests and answers.
//
// parse(buf) → value: dicts as plain objects, arrays, strings, numbers (integers past 2^53 as BigInt),
//   booleans, null, Buffers for data, Dates.
// build(value) → Buffer. Integers go as ints, other numbers as reals; Buffers as data; a BigInt as a
//   64-bit int; {real: n} forces a real for a whole number (AirPlay wants refreshRate as one).
'use strict';

const EPOCH = 978307200; // 2001-01-01, the plist epoch, in Unix seconds

function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('not a binary plist');
  const t = buf.length - 32;
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const table = Number(buf.readBigUInt64BE(t + 24));
  if (!offSize || !refSize || offSize > 8 || refSize > 8 || count > 1e6 || table + count * offSize > t) throw new Error('bad plist trailer');
  const uint = (at, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[at + i]; return v; };
  const offset = (i) => uint(table + i * offSize, offSize);
  let depth = 0;

  function obj(i) {
    if (i >= count) throw new Error('bad plist ref');
    if (++depth > 64) throw new Error('plist too deep');
    try { return read(offset(i)); } finally { depth--; }
  }
  // A length: in the marker's low nibble, or an int object after it when that's 0xF.
  function len(at) {
    const n = buf[at] & 0x0f;
    if (n !== 0x0f) return [n, at + 1];
    const m = buf[at + 1];
    if ((m & 0xf0) !== 0x10) throw new Error('bad plist length');
    const sz = 1 << (m & 0x0f);
    return [uint(at + 2, sz), at + 2 + sz];
  }
  function read(at) {
    if (at >= t) throw new Error('bad plist offset');
    const m = buf[at];
    const hi = m >> 4;
    switch (hi) {
      case 0x0: return m === 0x08 ? false : m === 0x09 ? true : null;
      case 0x1: {
        const sz = 1 << (m & 0x0f);
        if (sz === 8) { const v = buf.readBigInt64BE(at + 1); return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v; }
        if (sz === 16) return buf.readBigInt64BE(at + 9);
        return uint(at + 1, sz);
      }
      case 0x2: return (m & 0x0f) === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
      case 0x3: return new Date((buf.readDoubleBE(at + 1) + EPOCH) * 1000);
      case 0x4: { const [n, s] = len(at); return Buffer.from(buf.subarray(s, s + n)); }
      case 0x5: { const [n, s] = len(at); return buf.toString('latin1', s, s + n); }
      case 0x6: { const [n, s] = len(at); return Buffer.from(buf.subarray(s, s + n * 2)).swap16().toString('utf16le'); }
      case 0x8: return uint(at + 1, (m & 0x0f) + 1); // UID
      case 0xa: { const [n, s] = len(at); const out = []; for (let k = 0; k < n; k++) out.push(obj(uint(s + k * refSize, refSize))); return out; }
      case 0xd: {
        const [n, s] = len(at);
        const out = {};
        for (let k = 0; k < n; k++) {
          const key = obj(uint(s + k * refSize, refSize));
          out[String(key)] = obj(uint(s + (n + k) * refSize, refSize));
        }
        return out;
      }
      default: throw new Error(`plist type 0x${m.toString(16)}`);
    }
  }
  return obj(top);
}

function build(root) {
  const objs = []; // encoded objects, in order; refs are indexes
  const sizeFor = (n) => (n < 256 ? 1 : n < 65536 ? 2 : n < 2 ** 32 ? 4 : 8);
  const uintBuf = (v, n) => { const b = Buffer.alloc(n); for (let i = n - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); } return b; };
  const marker = (type, n) => (n < 15 ? Buffer.from([(type << 4) | n]) : Buffer.concat([Buffer.from([(type << 4) | 0x0f]), intObj(n)]));
  function intObj(v) {
    if (typeof v === 'bigint' || v < 0 || v > 0xffffffff) { const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(BigInt(v), 1); return b; }
    const n = v < 256 ? 1 : v < 65536 ? 2 : 4;
    return Buffer.concat([Buffer.from([0x10 | Math.log2(n)]), uintBuf(v, n)]);
  }
  // Refs are written once all objects are known; collect first.
  const nodes = [];
  function add(v) {
    const i = nodes.length;
    nodes.push(null);
    if (v === null || v === undefined) nodes[i] = { raw: Buffer.from([0x00]) };
    else if (v === false || v === true) nodes[i] = { raw: Buffer.from([v ? 0x09 : 0x08]) };
    else if (typeof v === 'bigint') nodes[i] = { raw: intObj(v) };
    else if (typeof v === 'number') {
      if (Number.isInteger(v)) nodes[i] = { raw: intObj(v) };
      else { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v, 1); nodes[i] = { raw: b }; }
    } else if (typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v).length === 1 && 'real' in v && typeof v.real === 'number') {
      const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v.real, 1); nodes[i] = { raw: b };
    } else if (typeof v === 'string') {
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(v)) nodes[i] = { raw: Buffer.concat([marker(0x5, v.length), Buffer.from(v, 'latin1')]) };
      else { const u = Buffer.from(v, 'utf16le').swap16(); nodes[i] = { raw: Buffer.concat([marker(0x6, u.length / 2), u]) }; }
    } else if (Buffer.isBuffer(v) || v instanceof Uint8Array) nodes[i] = { raw: Buffer.concat([marker(0x4, v.length), Buffer.from(v)]) };
    else if (v instanceof Date) { const b = Buffer.alloc(9); b[0] = 0x33; b.writeDoubleBE(v.getTime() / 1000 - EPOCH, 1); nodes[i] = { raw: b }; }
    else if (Array.isArray(v)) { const refs = v.map(add); nodes[i] = { type: 0xa, n: v.length, refs }; }
    else if (typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      const kr = keys.map(add);
      const vr = keys.map((k) => add(v[k]));
      nodes[i] = { type: 0xd, n: keys.length, refs: [...kr, ...vr] };
    } else throw new Error(`can't put ${typeof v} in a plist`);
    return i;
  }
  add(root);
  const refSize = sizeFor(nodes.length);
  for (const n of nodes) objs.push(n.raw || Buffer.concat([marker(n.type, n.n), ...n.refs.map((r) => uintBuf(r, refSize))]));
  const head = Buffer.from('bplist00', 'latin1');
  let at = head.length;
  const offsets = objs.map((o) => { const x = at; at += o.length; return x; });
  const offSize = sizeFor(at);
  const table = Buffer.concat(offsets.map((o) => uintBuf(o, offSize)));
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objs.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([head, ...objs, table, trailer]);
}

module.exports = { parse, build };
