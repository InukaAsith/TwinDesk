// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// ../helper.js with Multi-device's helper: macshare-helper-multi, the same sources built with -D MULTI
// (several watched edges, the #if MULTI parts of mac-helper's Capture.swift). Where it isn't built (an
// older .build/), the one-to-one helper starts instead and watches the first edge the mesh names (kvm.js
// sends it as side).
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { Helper } = require('../helper');

const RELEASE = path.join(__dirname, '..', '..', 'mac-helper', '.build', 'release');
const MULTI = path.join(RELEASE, 'macshare-helper-multi');
const BIN = fs.existsSync(MULTI) ? MULTI : path.join(RELEASE, 'macshare-helper');

class MeshHelper extends Helper {
  // Every feature listens to the helper, and Multi-device has some per device (shared/files-mesh.js):
  // past Node's 10 by design ('MaxListenersExceededWarning' at every start). 100 still flags a leak.
  constructor(...args) {
    super(...args);
    this.setMaxListeners(100);
  }

  // ../helper.js's start() with this BIN.
  start() {
    if (this.proc) return true;
    if (!fs.existsSync(BIN)) {
      console.error(`[helper] ${BIN} not found — run "npm run build:helper"`);
      return false;
    }
    const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    proc.stdio[3].on('data', (buf) => this.emit('pcm', buf));
    proc.stdio[3].on('error', () => {});
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(line));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => console.log(line));
    proc.stdin.on('error', () => {}); // EPIPE when the helper died; 'exit' handles it
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('helper exited'));
      }
      this.pending.clear();
      if (!this.stopping) console.error(`[helper] exited (${signal || code})`);
      this.emit('exit', code);
    });
    proc.on('error', (err) => console.error(`[helper] spawn failed: ${err.message}`));
    this.emit('ready');
    return true;
  }
}

module.exports = { Helper: MeshHelper };
