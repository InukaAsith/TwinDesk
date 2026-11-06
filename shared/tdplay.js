// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Process manager for the tdplay headless AirPlay receiver helper.
// Launched strictly on demand when AirPlay Receiver is switched ON.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const MAGIC = Buffer.from('TDP1');
const TYPE_EVENT = 0;
const TYPE_VIDEO = 1;

class TdPlayManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.child = null;
    this.running = false;
    this.buffer = Buffer.alloc(0);
    this.activeDevice = null;
  }

  static findBinary() {
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'tdplay.exe' : 'tdplay';

    const candidates = [
      path.join(__dirname, '..', 'native', 'tdplay', 'target', 'release', binName),
      path.join(__dirname, '..', 'native', 'tdplay', 'target', 'debug', binName),
      path.join(__dirname, '..', 'windows-helper', 'bin', binName),
      path.join(__dirname, '..', 'linux-helper', 'bin', binName),
      path.join(process.resourcesPath || '', 'bin', binName),
      path.join(__dirname, '..', 'bin', binName),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  start({ name = 'TwinDesk', port = 7000, mirrorPort = 7100, keyPath } = {}) {
    if (this.child && !this.child.killed) return;

    const bin = TdPlayManager.findBinary();
    if (!bin) {
      const err = new Error('tdplay binary not found. Build it with: cd native/tdplay && cargo build --release');
      this.emit('error', err);
      return;
    }

    const args = [
      '--name', name,
      '--port', String(port),
      '--mirror-port', String(mirrorPort),
    ];
    if (keyPath) args.push('--key', keyPath);

    this.buffer = Buffer.alloc(0);
    this.child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.running = true;

    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log(`[tdplay] ${msg}`);
    });

    this.child.on('close', (code) => {
      this.running = false;
      this.child = null;
      this.activeDevice = null;
      this.emit('stopped', code);
    });

    this.child.on('error', (err) => {
      this.emit('error', err);
    });

    this.emit('starting');
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch (_) {}
    this.child = null;
    this.running = false;
    this.activeDevice = null;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 9) {
      // Look for magic TDP1
      if (!this.buffer.subarray(0, 4).equals(MAGIC)) {
        // Discard byte until MAGIC is aligned
        const idx = this.buffer.indexOf(MAGIC);
        if (idx === -1) {
          this.buffer = Buffer.alloc(0);
          break;
        }
        this.buffer = this.buffer.subarray(idx);
        if (this.buffer.length < 9) break;
      }

      const type = this.buffer[4];
      const len = this.buffer.readUInt32BE(5);
      const totalLen = 9 + len;

      if (this.buffer.length < totalLen) {
        break; // Wait for full packet
      }

      const payload = this.buffer.subarray(9, totalLen);
      this.buffer = this.buffer.subarray(totalLen);

      if (type === TYPE_EVENT) {
        try {
          const ev = JSON.parse(payload.toString('utf8'));
          this._handleEvent(ev);
        } catch (e) {
          console.error('[tdplay] Failed to parse event JSON:', e);
        }
      } else if (type === TYPE_VIDEO) {
        this.emit('video', payload);
        this._demuxVideo(payload);
      }
    }
  }

  _demuxVideo(payload) {
    let spsPpsEnd = -1;
    let hasSps = false;
    let hasPps = false;
    let isKey = false;
    let sliceStart = -1;

    let i = 0;
    while (i < payload.length - 4) {
      let scLen = 0;
      if (payload[i] === 0 && payload[i + 1] === 0) {
        if (payload[i + 2] === 1) scLen = 3;
        else if (payload[i + 2] === 0 && payload[i + 3] === 1) scLen = 4;
      }
      if (scLen > 0) {
        const nalType = payload[i + scLen] & 0x1f;
        if (nalType === 7) {
          hasSps = true;
        } else if (nalType === 8) {
          hasPps = true;
        } else if (nalType === 5) {
          isKey = true;
          if (sliceStart === -1) sliceStart = i;
        } else if (nalType === 1) {
          if (sliceStart === -1) sliceStart = i;
        }
        if ((hasSps || hasPps) && sliceStart !== -1 && spsPpsEnd === -1) {
          spsPpsEnd = sliceStart;
        }
        i += scLen;
      } else {
        i++;
      }
    }

    const nowUs = Math.round(performance.now() * 1000);

    if (hasSps && hasPps && spsPpsEnd > 0) {
      const configData = payload.subarray(0, spsPpsEnd);
      this.emit('packet', { config: true, key: false, pts: nowUs, data: configData });
      const sliceData = payload.subarray(spsPpsEnd);
      this.emit('packet', { config: false, key: isKey, pts: nowUs, data: sliceData });
    } else {
      this.emit('packet', { config: false, key: isKey, pts: nowUs, data: payload });
    }
  }

  _handleEvent(ev) {
    if (!ev || !ev.event) return;
    if (ev.event === 'ready') {
      this.emit('ready', ev);
    } else if (ev.event === 'client_connecting') {
      this.activeDevice = ev;
      this.emit('client', ev);
    } else if (ev.event === 'mirror_start') {
      this.emit('mirror_start', this.activeDevice);
    } else if (ev.event === 'mirror_stop') {
      this.emit('mirror_stop');
      this.activeDevice = null;
    }
  }
}

module.exports = { TdPlayManager };
