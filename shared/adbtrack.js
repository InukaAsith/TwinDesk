// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The adb server's own list of devices, as it changes (its host:track-devices service on
// 127.0.0.1:5037), so adb.devices() doesn't start an `adb devices` process every poll (wired.js
// polls every 2 s while an Android phone is linked). One idle socket: no CPU while nothing changes.
//
// Starts only when asked (the first adb.devices(), so only once a phone is here); list is null while
// it isn't connected (no adb server yet, or another adb killed it), and adb.devices() then runs
// `adb devices` as before, which starts the server, and tries the feed again.
'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const PORT = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5037;
const RETRY_MS = 5000;

// "serial\tstate\n…" → [{serial, state}]
// Split at the tab: an mDNS serial can have spaces ("adb-R5CT-x (2)._adb-tls-connect._tcp").
function parse(text) {
  return String(text).split('\n').map((l) => l.replace(/\r$/, '').split('\t')).filter((p) => p.length >= 2 && p[0].trim())
    .map(([serial, state]) => ({ serial: serial.trim(), state: state.trim().split(/\s+/)[0] }));
}

// An adb host request: 4 hex digits of length, then the text.
function request(text) {
  return Buffer.from(text.length.toString(16).padStart(4, '0') + text, 'utf8');
}

class AdbTrack extends EventEmitter {
  constructor({ port = PORT, connect = net.connect } = {}) {
    super();
    this.port = port;
    this.connect = connect;
    this.list = null;
    this.sock = null;
    this.lastTry = 0;
  }

  // Connect if not connected (at most every RETRY_MS). The list arrives with the first message.
  ensure() {
    if (this.sock || Date.now() - this.lastTry < RETRY_MS) return;
    this.lastTry = Date.now();
    let buf = Buffer.alloc(0);
    let okay = false;
    const s = this.connect({ host: '127.0.0.1', port: this.port });
    this.sock = s;
    s.setNoDelay(true);
    s.on('connect', () => s.write(request('host:track-devices')));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!okay) {
        if (buf.length < 4) return;
        if (buf.toString('latin1', 0, 4) !== 'OKAY') return s.destroy();
        okay = true;
        buf = buf.subarray(4);
      }
      while (buf.length >= 4) {
        const n = parseInt(buf.toString('latin1', 0, 4), 16);
        if (!Number.isFinite(n) || n < 0) return s.destroy();
        if (buf.length < 4 + n) return;
        const list = parse(buf.toString('utf8', 4, 4 + n));
        buf = buf.subarray(4 + n);
        const changed = JSON.stringify(list) !== JSON.stringify(this.list);
        this.list = list;
        if (changed) this.emit('change', list);
      }
    });
    const gone = () => {
      if (this.sock !== s) return;
      this.sock = null;
      if (this.list !== null) { this.list = null; this.emit('change', null); }
    };
    s.on('error', gone);
    s.on('close', gone);
  }

  stop() {
    const s = this.sock;
    this.sock = null;
    this.list = null;
    if (s) s.destroy();
  }
}

module.exports = { AdbTrack, parse, request };
