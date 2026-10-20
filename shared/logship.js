// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Sends a device's log lines to a log server on the local network (tools/logserver.js), so what
// happens on a phone or another computer can be read in one place while testing. Lines are sent in
// small batches (POST <url> {device, lines}); an unreachable server is retried later and never
// slows or breaks the app: at most MAX_PENDING lines wait. Off when the url is empty or 'off'.
// Plain Node (http), no Electron.
'use strict';

const http = require('http');
const { URL } = require('url');

const MAX_PENDING = 500;
const EVERY_MS = 1500;
const RETRY_MS = 15000;

class LogShip {
  constructor({ url, device, request = http.request }) {
    this.device = String(device || 'device').slice(0, 80);
    this.request = request;
    this.pending = [];
    this.busy = false;
    this.nextTry = 0;
    this.timer = null;
    try {
      this.url = url && url !== 'off' ? new URL(url) : null;
    } catch (_) {
      this.url = null;
    }
    if (this.url) {
      this.timer = setInterval(() => this.flush(), EVERY_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  push(line) {
    if (!this.url) return;
    this.pending.push(String(line).slice(0, 2000));
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
  }

  flush() {
    if (!this.url || this.busy || !this.pending.length || Date.now() < this.nextTry) return;
    const lines = this.pending.splice(0, 200);
    const body = JSON.stringify({ device: this.device, lines });
    this.busy = true;
    const done = (ok) => {
      this.busy = false;
      if (!ok) {
        this.pending.unshift(...lines);
        if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
        this.nextTry = Date.now() + RETRY_MS;
      }
    };
    try {
      const req = this.request({
        hostname: this.url.hostname, port: this.url.port || 80, path: this.url.pathname || '/', method: 'POST', timeout: 3000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        done(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on('error', () => done(false));
      req.on('timeout', () => req.destroy());
      req.end(body);
    } catch (_) {
      done(false);
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { LogShip };
