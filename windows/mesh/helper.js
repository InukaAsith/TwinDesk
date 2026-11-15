// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// ../helper.js with Multi-device's helper: macshare-winhelper-multi.exe, the same sources built with MULTI
// (several watched sides, windows-helper/src/CaptureMulti.cs). Where it isn't built (an older bin/), the
// one-to-one helper starts instead and watches the first side the mesh names (kvm.js sends it as side).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Helper = require('../helper');

const MULTI = path.join(__dirname, '..', '..', 'windows-helper', 'bin', 'macshare-winhelper-multi.exe');
const EXE = fs.existsSync(MULTI) ? MULTI : Helper.EXE;
const RESTART_MS = 1000;

class MeshHelper extends Helper {
  // ../helper.js's start() with this EXE.
  start() {
    this.stopped = false;
    if (this.proc) return;
    if (!fs.existsSync(EXE)) {
      this.error = 'Helper not built (run npm run build:helper)';
      this.emit('exit', -1);
      return;
    }
    // Windows can refuse to start it (Smart App Control, a work PC's policy: spawn EPERM). As in
    // ../helper.js the app goes on without it: thrown from here, start() stopped before the window (#216).
    let proc;
    try {
      proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this._blocked(e);
      return;
    }
    if (!proc.pid) { // failed: 'error' follows, and no 'exit'
      proc.on('error', (e) => this._blocked(e));
      return;
    }
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this._data(d));
    proc.stderr.on('data', (d) => console.warn('[helper]', String(d).trim()));
    proc.stdin.on('error', () => {}); // EPIPE while it exits
    proc.on('error', (e) => { this.error = e.message; });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error('helper exited'));
      this.pending.clear();
      this.emit('exit', code);
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), RESTART_MS);
    });
  }
}

MeshHelper.EXE = EXE;
module.exports = MeshHelper;
