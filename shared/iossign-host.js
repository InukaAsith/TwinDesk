// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/iossign.js in an app (Mac, PC and Linux): where the signing helper is, this feature's own
// settings file, and the vault for a kept copy.
//   ios-signing.json  {auto, days, keep, device, alone}: plain, nothing secret in it.
//   ios-signing.bin   the kept copy (only with Keep a copy on), sealed by the system through
//                     Electron's safeStorage: the Keychain on a Mac, DPAPI on Windows, the Secret
//                     Service on Linux. Without one of those there is no vault and no Keep a copy.
// create({app, safeStorage, link, usbSerials, onChange}) → an IosSign; pickIpa(sign, dialog, win).
'use strict';

const fs = require('fs');
const path = require('path');
const { IosSign } = require('./iossign.js');

const EXE = process.platform === 'win32' ? 'twindesk-ios-signer.exe' : 'twindesk-ios-signer';
const ROOT = path.join(__dirname, '..', 'ios-signer');
// As packaged (bin/<x64|arm64>/, ios-signer/build.sh), then a developer's own build.
const BINS = [path.join(ROOT, 'bin', process.arch, EXE), path.join(ROOT, 'target', 'release', EXE), path.join(ROOT, 'target', 'debug', EXE)];

function create({ app, safeStorage, link, usbSerials, onChange }) {
  const dir = app.getPath('userData');
  const cfgFile = path.join(dir, 'ios-signing.json');
  const vaultFile = path.join(dir, 'ios-signing.bin');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch {}
  // Only a real system store counts: Linux's "basic_text" fallback is a fixed key, which is no vault.
  const sealed = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === 'basic_text');
    } catch {
      return false;
    }
  };
  const vault = sealed() ? {
    load() {
      try { return safeStorage.decryptString(fs.readFileSync(vaultFile)); } catch { return ''; }
    },
    save(text) {
      try {
        if (!text) return fs.rmSync(vaultFile, { force: true });
        fs.writeFileSync(vaultFile, safeStorage.encryptString(text), { mode: 0o600 });
      } catch {}
    },
  } : null;
  if (!vault) { cfg.keep = false; try { fs.rmSync(vaultFile, { force: true }); } catch {} }
  // A developer's test run (ios-signer/try.sh) left its state in a file: the iPhone's app takes it
  // over the first time it is connected, and the file goes. Never there in a packaged app.
  const seedFile = path.join(ROOT, '.try-state.json');
  let seed = null;
  try { seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')); } catch {}
  const sign = new IosSign({
    link, bins: BINS, usbSerials, vault, seed,
    cfg: () => cfg,
    setCfg: (patch) => {
      cfg = { ...cfg, ...patch };
      try { fs.writeFileSync(cfgFile, JSON.stringify(cfg)); } catch {}
    },
  });
  sign.on('change', onChange);
  if (seed) sign.once('handed', () => { try { fs.rmSync(seedFile, { force: true }); } catch {} });
  return sign;
}

// Choose an IPA… (builds that install other apps).
async function pickIpa(sign, dialog, win) {
  if (!sign) return;
  const r = await dialog.showOpenDialog(win || undefined, { title: 'IPA', properties: ['openFile'], filters: [{ name: 'IPA', extensions: ['ipa'] }] });
  if (!r.canceled && r.filePaths[0]) sign.setIpa(r.filePaths[0]);
}

module.exports = { create, pickIpa, BINS };
