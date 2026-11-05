// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// ../helper.js with Multi-device's helper: macshare-linuxhelper-multi, the same sources built with
// -DMULTI (several watched edges on X11: the #ifdef MULTI parts of linux-helper/src/capture.c and
// main.c). Where it isn't built (an older bin/), the one-to-one helper starts instead and watches the
// first edge the mesh names (kvm.js sends it as side).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { helperBin } = require('../system.js'); // its setgid input copy on Wayland (#144)
const Helper = require('../helper');

const BIN_DIR = path.join(__dirname, '..', '..', 'linux-helper', 'bin');
const MULTI = path.join(BIN_DIR, 'macshare-linuxhelper-multi');
const BIN = fs.existsSync(MULTI) ? MULTI : path.join(BIN_DIR, 'macshare-linuxhelper');
const RESTART_MS = 1000;

class MeshHelper extends Helper {
  // ../helper.js's start() with this BIN.
  start() {
    this.stopped = false;
    if (this.proc) return;
    const why = this.canRun();
    if (why) {
      this.error = why;
      this.emit('exit', -1);
      return;
    }
    if (!fs.existsSync(BIN)) {
      this.error = 'Helper not built (run npm run build:helper)';
      this.emit('exit', -1);
      return;
    }
    const proc = spawn(helperBin(BIN), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.buf = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this._data(d));
    proc.stderr.on('data', (d) => {
      stderr = String(d).trim();
      console.warn('[helper]', stderr);
    });
    proc.stdin.on('error', () => {}); // EPIPE while it exits
    proc.on('error', (e) => { this.error = e.message; });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error('helper exited'));
      this.pending.clear();
      this.backend = '';
      if (code && !this.stopped) this.error = stderr ? stderr.split('\n').pop() : 'The helper stopped (' + code + ')';
      this.emit('exit', code);
      // Exits right after starting (no display, no XInput 2): try less often.
      this.fails = this.error && code ? this.fails + 1 : 0;
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), RESTART_MS * Math.min(30, 1 + this.fails * this.fails));
    });
  }
}

module.exports = MeshHelper;
