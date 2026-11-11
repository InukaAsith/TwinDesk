// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/iossign.js in an app (Mac, PC and Linux): where the signing helper is, this feature's own
// settings file, and the vault for a kept copy.
//   ios-signing.json  {on, auto, days, how, which, retry, cache, keep, device, alone}: plain, nothing secret in it.
//   ios-signing.bin   the kept copy (Keep a copy, on by default while the feature is on), sealed by the
//                     system through Electron's safeStorage: the Keychain on a Mac (an item only
//                     TwinDesk may read without asking), DPAPI on Windows and the Secret Service on
//                     Linux (both open to any program of the same user). Without one of those there
//                     is no vault and no Keep a copy.
// create({app, safeStorage, link, near, usbSerials, onChange}) → an IosSign; pickIpa(sign, dialog, win).
'use strict';

const fs = require('fs');
const path = require('path');
const { IosSign } = require('./iossign.js');

const EXE = process.platform === 'win32' ? 'twindesk-ios-signer.exe' : 'twindesk-ios-signer';
const ROOT = path.join(__dirname, '..', 'ios-signer');
// As packaged (bin/<x64|arm64>/, ios-signer/build.sh), then a developer's own build.
const BINS = [path.join(ROOT, 'bin', process.arch, EXE), path.join(ROOT, 'target', 'release', EXE), path.join(ROOT, 'target', 'debug', EXE)];

function create({ app, safeStorage, link, near, usbSerials, onChange }) {
  const dir = app.getPath('userData');
  const cfgFile = path.join(dir, 'ios-signing.json');
  const vaultFile = path.join(dir, 'ios-signing.bin');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch {}
  // Only a real system store counts: Linux's "basic_text" fallback is a fixed key, which is no vault.
  // Asked only when the vault is used (Keep a copy on): on a Mac, asking at all is a Keychain prompt,
  // so nothing here touches safeStorage while TwinDesk iPhone is off or keeps no copy.
  const sealed = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === 'basic_text');
    } catch {
      return false;
    }
  };
  // Whether there can be one: a Mac and Windows always have theirs. On Linux, asking at all opens the
  // login keyring (an unlock prompt when it's locked), so it is asked only once TwinDesk iPhone is on
  // and wants the vault (shared/iossign.js reads vault.possible only then), never at start.
  let possibleSeen;
  const vault = {
    get possible() {
      if (process.platform !== 'linux') return true;
      if (possibleSeen === undefined) possibleSeen = sealed();
      return possibleSeen;
    },
    exists: () => fs.existsSync(vaultFile), // no Keychain asked
    load() {
      try { return fs.existsSync(vaultFile) && sealed() ? safeStorage.decryptString(fs.readFileSync(vaultFile)) : ''; } catch { return ''; }
    },
    save(text) {
      try {
        if (!text) return fs.rmSync(vaultFile, { force: true });
        if (sealed()) fs.writeFileSync(vaultFile, safeStorage.encryptString(text), { mode: 0o600 });
      } catch {}
    },
  };
  // A developer's test run (ios-signer/try.sh) left its state in a file: the iPhone's app takes it
  // over the first time it is connected, and the file goes. Never there in a packaged app.
  // (Next to the helper's sources, or as ios-signing-seed.json in this app's settings folder.)
  const seedFile = [path.join(ROOT, '.try-state.json'), path.join(dir, 'ios-signing-seed.json')].find((f) => fs.existsSync(f)) || '';
  let seed = null;
  try { seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')); } catch {}
  const sign = new IosSign({
    link, near, bins: BINS, usbSerials, vault, seed, cacheDir: path.join(dir, 'ios-ipas'),
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

// Turning it on: said once more, in a dialog of its own, before anything is switched.
async function enable(sign, dialog, win) {
  if (!sign) return;
  const r = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    message: 'Not recommended',
    detail: 'TwinDesk will sign in to Apple with your Apple ID to request development certificates and provisioning profiles for your iPhone or iPad. Apple may reject the sign-in, temporarily lock the account, or prevent it from signing apps.\n\nWe recommend AltStore for installing and refreshing TwinDesk.\n\nUse a dedicated Apple ID rather than your primary account.',
    buttons: ['Cancel', 'Turn On'], defaultId: 0, cancelId: 0,
  });
  if (r.response === 1) sign.set({ on: true });
}

// One action from the window ({a: 'enable'} asks first).
function act(sign, dialog, o) {
  if (!sign || !o || typeof o !== 'object') return;
  if (o.a === 'enable') return void enable(sign, dialog);
  if (o.a === 'set' && o.on === true) return; // only through the dialog
  if (o.a === 'answer' && Array.isArray(o.revoke)) return void revoke(sign, dialog, o.revoke[0]);
  sign.act(o);
}

// Revoking a certificate: TwinDesk's own as asked; another tool's after a warning of what it stops.
async function revoke(sign, dialog, serial) {
  const need = sign.run && sign.run.need;
  const cert = need && need.what === 'cert' && need.certs.find((c) => c.serial === serial);
  if (!cert) return;
  if (!cert.ours) {
    const by = cert.machine || cert.name || 'another tool';
    const r = await dialog.showMessageBox({
      type: 'warning',
      message: `Revoke the certificate made by ${by}?`,
      detail: `Apps signed with this certificate, by ${by} or any other tool, stop launching until they are signed again with a new certificate. If ${by} refreshes apps on this device, it has to make a new certificate the next time it runs.\n\nThis cannot be undone.`,
      buttons: ['Cancel', 'Revoke'], defaultId: 0, cancelId: 0,
    });
    if (r.response !== 1 || !sign.run || sign.run.need !== need) return;
  }
  sign.answer({ revoke: [serial] });
}

// Choose an IPA… (builds that install other apps).
async function pickIpa(sign, dialog, win) {
  if (!sign) return;
  const r = await dialog.showOpenDialog(win || undefined, { title: 'IPA', properties: ['openFile'], filters: [{ name: 'IPA', extensions: ['ipa'] }] });
  if (!r.canceled && r.filePaths[0]) sign.setIpa(r.filePaths[0]);
}

module.exports = { create, pickIpa, act, BINS };
