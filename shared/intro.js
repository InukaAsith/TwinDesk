// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Joining everyone (docs/mesh.md "Joining everyone"): pair once, the mesh pairs the rest.
//
// A device that is connected to two others that are NOT connected to each other introduces them:
//   introducer I, host H (a computer, it listens), guest G (it dials H):
//   I -> H  mesh.intro.ask   {req, for, name, os}        "make a pairing for G"
//   H -> I  mesh.intro.reply {req, for, ok, macId, macName, os, fp, port, addrs, token, error?}
//   I -> G  mesh.intro.grant {req, macId, macName, os, fp, port, addrs, token}
// G stores the grant like a finished pairing (macId, macName, address, port, fp, token, os) and
// dials H. Only a device that has an authenticated link to both takes part; a device with the
// setting mesh.autoJoin off neither asks nor accepts. Pure functions only: no sockets, no storage.
'use strict';

const ASK = 'mesh.intro.ask';
const REPLY = 'mesh.intro.reply';
const GRANT = 'mesh.intro.grant';
const RETRY_MS = 60000; // the same (host, guest) pair is not introduced again before this
const HEX = /^[0-9a-f]+$/;

const canHost = (os) => os === 'win' || os === 'mac' || os === 'linux'; // a phone cannot listen

// Which host a pair uses: the computer; between two computers the smaller device id (a computer
// that already dials the other keeps doing so: `dials` lists "guestId>hostId" links that exist).
function pickHost(a, b, dials = new Set()) {
  const ha = canHost(a.os);
  const hb = canHost(b.os);
  if (ha && !hb) return { host: a, guest: b };
  if (hb && !ha) return { host: b, guest: a };
  if (!ha && !hb) return null; // two phones: no direct link possible
  if (dials.has(`${a.id}>${b.id}`)) return { host: b, guest: a };
  if (dials.has(`${b.id}>${a.id}`)) return { host: a, guest: b };
  return a.id < b.id ? { host: a, guest: b } : { host: b, guest: a };
}

// peers: our direct, authenticated, mesh-speaking links [{id, os}]; roster: a Roster (shared/mesh.js);
// state: a Map the caller keeps ("host>guest" -> last time asked); dials: Set of existing dial
// links across the mesh "guest>host". Returns [{host, guest}] pairs to introduce now.
function plan({ selfId, peers, roster, state, now = Date.now(), dials = new Set() }) {
  const out = [];
  const list = peers.filter((p) => p && p.id && p.id !== selfId);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (roster.linked(a.id, b.id)) continue;
      const pair = pickHost(a, b, dials);
      if (!pair) continue;
      const key = `${pair.host.id}>${pair.guest.id}`;
      if (state.has(key) && now - state.get(key) < RETRY_MS) continue;
      state.set(key, now);
      out.push({ host: pair.host.id, guest: pair.guest.id, hostOs: pair.host.os, guestOs: pair.guest.os, key });
    }
  }
  return out;
}

const str = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;

function validAsk(m) {
  return !!m && m.t === ASK && str(m.req, 64) && str(m.for, 128) && (m.name === undefined || typeof m.name === 'string');
}

// A reply/grant carries the whole credential. fp: SHA-256 hex (any case, colons allowed), token: hex.
function validGrant(m) {
  if (!m || (m.t !== GRANT && m.t !== REPLY) || !str(m.req, 64)) return false;
  if (m.t === REPLY && m.ok === false) return true;
  const fp = typeof m.fp === 'string' ? m.fp.replace(/:/g, '').toLowerCase() : '';
  return str(m.macId, 128) && fp.length === 64 && HEX.test(fp) && str(m.token, 128) && HEX.test(m.token)
    && Number.isInteger(m.port) && m.port > 0 && m.port < 65536
    && Array.isArray(m.addrs) && m.addrs.length > 0 && m.addrs.length <= 8 && m.addrs.every((x) => str(x, 64));
}

const newReq = () => require('crypto').randomBytes(8).toString('hex');

// The introducer's pending table: req -> {host, guest, at}. A reply is only forwarded for a request
// we made, from the host we asked, and only once.
class Pending {
  constructor(ttlMs = 30000) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  add(req, host, guest, now = Date.now()) {
    this.map.set(req, { host, guest, at: now });
  }
  take(req, fromHost, now = Date.now()) {
    const e = this.map.get(req);
    this.map.delete(req);
    return e && e.host === fromHost && now - e.at <= this.ttlMs ? e : null;
  }
  sweep(now = Date.now()) {
    for (const [k, e] of this.map) if (now - e.at > this.ttlMs) this.map.delete(k);
  }
}

module.exports = { ASK, REPLY, GRANT, RETRY_MS, canHost, pickHost, plan, validAsk, validGrant, newReq, Pending };
