// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Remote › Real gamepad on Windows (shared/phone-remote.js's pad driver): the phone's gamepad as an
// Xbox 360 controller every game sees, through the ViGEmBus driver. ViGEmBus is installed the first
// time it's turned on (one UAC prompt, scripts/vigem-install.ps1: its signed installer, checked by
// sha256); windows-helper/bin/twindesk-pad.exe plugs the controller in and feeds it the pad states
// on its stdin. Loaded only when Real gamepad is turned on.
const { app } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scriptElevated } = require('./ps');

const EXE = path.join(__dirname, '..', 'windows-helper', 'bin', 'twindesk-pad.exe');
// ViGEmBus 1.22.0 (https://github.com/nefarius/ViGEmBus, BSD-3-Clause), signed by Nefarius Software Solutions e.U.
const BUS = {
  url: 'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe',
  sha256: '89220A7865076B342892F98865F3499FB7C4CFD673159E89D352C360FD014C6A',
};

function status() {
  return new Promise((resolve) => {
    execFile(EXE, ['status'], { windowsHide: true, timeout: 10000 }, (_err, stdout) => {
      try { resolve(JSON.parse(String(stdout).trim())); } catch { resolve({}); }
    });
  });
}

const driver = {
  name: 'Xbox 360 controller',
  kinds: ['xbox', 'ds4'], // or a PlayStation DualShock 4 (#266)

  async check() {
    if (!fs.existsSync(EXE)) return { supported: false, message: 'Not in this build of TwinDesk' };
    return { supported: true, installed: (await status()).bus === true };
  },

  // One UAC prompt: ViGEmBus's installer, quietly.
  async install() {
    const log = path.join(app.getPath('userData'), 'vigem-result.txt');
    try { fs.unlinkSync(log); } catch {}
    try {
      await scriptElevated('vigem-install', { Url: BUS.url, Sha256: BUS.sha256, Log: log }, 300000);
    } catch (e) {
      throw new Error(/cancel/i.test(e.message) ? 'The administrator prompt was declined' : e.message);
    }
    const r = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : 'error: the setup didn’t finish';
    try { fs.unlinkSync(log); } catch {}
    if (r !== 'ok') throw new Error(r.replace(/^error: /, ''));
    if ((await status()).bus !== true) throw new Error('ViGEmBus was installed but doesn’t answer yet: restart Windows');
  },

  // The controller, plugged in while this runs; pad states (12 bytes each) go to its stdin.
  feed(onExit, kind) {
    const p = spawn(EXE, kind === 'ds4' ? ['feed', 'ds4'] : ['feed'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('exit', onExit);
    p.on('error', onExit);
    p.stdin.on('error', () => {});
    return p;
  },
};

module.exports = driver;
