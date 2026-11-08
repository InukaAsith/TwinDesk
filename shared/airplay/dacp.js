// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// After UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0; its DACP remote, uxplay.cpp and
// lib/raop_rtp.c remote_control_id) and shairport-sync: all credit for the protocol is theirs.
// Play/Pause, Next and Previous for music an app plays here: the sender names its remote control in
// each request (DACP-ID, Active-Remote headers); it is the service iTunes_Ctrl_<DACP-ID>._dacp._tcp
// on the sender, found with one multicast DNS question (asked from our own port, so the answer
// comes straight back), then an HTTP GET /ctrl-int/1/<command> with the Active-Remote header.
//
// dacpSend({ip, id, remote}, cmd) → Promise<boolean>; cmd: 'playpause' | 'nextitem' | 'previtem'
'use strict';

const dgram = require('dgram');
const http = require('http');

const ports = new Map(); // `${ip} ${id}` → port, as found

function encodeName(labels) {
  return Buffer.concat([...labels.map((l) => { const b = Buffer.from(l, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
}

// Skip a (possibly compressed) name; → the offset after it.
function skipName(b, i) {
  for (let g = 0; g < 128 && i < b.length; g++) {
    const n = b[i];
    if (n === 0) return i + 1;
    if ((n & 0xc0) === 0xc0) return i + 2;
    i += 1 + n;
  }
  return -1;
}

// The SRV record's port for the sender's remote control, from its answer.
function srvPort(b) {
  if (b.length < 12) return 0;
  const qd = b.readUInt16BE(4);
  const rr = b.readUInt16BE(6) + b.readUInt16BE(8) + b.readUInt16BE(10);
  let i = 12;
  for (let q = 0; q < qd; q++) { i = skipName(b, i); if (i < 0) return 0; i += 4; }
  for (let r = 0; r < rr && i >= 0 && i + 10 <= b.length; r++) {
    i = skipName(b, i);
    if (i < 0 || i + 10 > b.length) return 0;
    const type = b.readUInt16BE(i);
    const len = b.readUInt16BE(i + 8);
    if (type === 33 && len >= 6) return b.readUInt16BE(i + 10 + 4);
    i += 10 + len;
  }
  return 0;
}

function findPort(ip, id) {
  const key = `${ip} ${id}`;
  if (ports.has(key)) return Promise.resolve(ports.get(key));
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (p) => { clearTimeout(timer); clearInterval(again); try { s.close(); } catch (_) {} if (p) ports.set(key, p); resolve(p || 0); };
    const name = [`iTunes_Ctrl_${id}`, '_dacp', '_tcp', 'local'];
    const q = Buffer.concat([Buffer.from([0, 0x2a, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), encodeName(name), Buffer.from([0, 33, 0x80, 1])]); // SRV, unicast answer wanted
    s.on('error', () => done(0));
    s.on('message', (m) => { const p = srvPort(m); if (p) done(p); });
    const ask = () => {
      try { s.send(q, 5353, '224.0.0.251'); } catch (_) {}
      try { s.send(q, 5353, ip); } catch (_) {} // straight to the sender too
    };
    s.bind(0, ask);
    const again = setInterval(ask, 700);
    const timer = setTimeout(() => done(0), 2500);
  });
}

async function dacpSend(who, cmd) {
  if (!who || !who.ip || !who.id || !who.remote || !/^(playpause|nextitem|previtem|play|pause)$/.test(cmd)) return false;
  const port = await findPort(who.ip, who.id);
  if (!port) { console.warn('[airplay] no remote control found on', who.ip); return false; }
  return new Promise((resolve) => {
    const r = http.request({ host: who.ip, port, path: `/ctrl-int/1/${cmd}`, method: 'GET', timeout: 3000, headers: { 'Active-Remote': who.remote } }, (res) => {
      res.resume();
      if (res.statusCode >= 400) ports.delete(`${who.ip} ${who.id}`);
      resolve(res.statusCode < 400);
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => { ports.delete(`${who.ip} ${who.id}`); resolve(false); });
    r.end();
  });
}

module.exports = { dacpSend, srvPort };
