// TwinDesk Mesh — fork build identity. Everything that decides "is this the same app as upstream
// TwinDesk" (display name, data folder) lives here so the fork installs next to upstream.
// The network protocol (shared/protocol.js) is NOT touched: a Mesh build still talks to upstream.
const fs = require('fs');
const path = require('path');

const NAME = 'TwinDesk Mesh';
const DATA_DIR = 'TwinDesk Mesh'; // userData folder name under the platform's appData
// Folders upstream TwinDesk used, newest-looking first (it still uses 'MacShare').
const LEGACY_DATA_DIRS = ['MacShare', 'TwinDesk'];
// Not worth copying (rebuilt by Electron, or per-process locks).
const SKIP = /^(logs|Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad|blob_storage|Network|Session Storage|Shared Dictionary|SingletonLock|SingletonCookie|SingletonSocket|lockfile)$/i;

// True when a data folder already has this app's own state (settings, device id or identity).
function hasState(dir) {
  return ['settings.json', 'device.json', 'identity'].some((n) => fs.existsSync(path.join(dir, n)));
}

function copyTree(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const n of fs.readdirSync(from)) {
      if (SKIP.test(n)) continue;
      try { copyTree(path.join(from, n), path.join(to, n)); } catch (e) { /* unreadable entry: skip */ }
    }
  } else if (st.isFile()) {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); // never overwrite
  }
}

// One-time, safe migration: if the Mesh data folder has no settings/identity yet and an upstream
// folder exists, COPY it (never move or delete) so pairings and settings survive.
// Returns the source folder used, or '' when nothing was copied.
function migrateUserData(appDataDir, { dataDir = DATA_DIR, legacy = LEGACY_DATA_DIRS } = {}) {
  try {
    const target = path.join(appDataDir, dataDir);
    if (hasState(target)) return '';
    for (const name of legacy) {
      const src = path.join(appDataDir, name);
      if (src === target || !fs.existsSync(src) || !hasState(src)) continue;
      copyTree(src, target);
      return src;
    }
  } catch (e) { /* a failed copy just means a fresh start; never block startup */ }
  return '';
}

module.exports = { NAME, DATA_DIR, LEGACY_DATA_DIRS, migrateUserData, hasState };
