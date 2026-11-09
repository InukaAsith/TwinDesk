// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fetches adb for Windows (Android platform-tools: adb.exe and its two DLLs) into a folder,
// windows/vendor/adb by default. installer/build.js runs it for the installer; run it once
// (`npm run fetch-adb`) for a dev copy that has no Android SDK. Needs tar (Windows 10 and later,
// macOS) to unpack the zip.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// A fixed release (not platform-tools-latest, which changes under the pin) and its SHA-256, as
// vdd.js and gamepad.js pin their downloads. A newer adb: bump both together.
const ZIP_URL = 'https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip';
const ZIP_SHA256 = '45F4D63113E895EBDE0C90F194099A4676B6AC653BD28D54314A9E022BBC1A99';
const FILES = ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'];

function download(url, to, hops = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, to, hops - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Download failed: HTTP ' + res.statusCode + ' for ' + url));
      }
      const out = fs.createWriteStream(to);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchAdb(dest = path.join(__dirname, '..', 'vendor', 'adb')) {
  if (FILES.every((f) => fs.existsSync(path.join(dest, f)))) return dest;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-adb-'));
  try {
    const zip = path.join(tmp, 'platform-tools.zip');
    console.log('Downloading adb (Android platform-tools)…');
    await download(ZIP_URL, zip);
    const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex').toUpperCase();
    if (got !== ZIP_SHA256) throw new Error('adb zip SHA-256 mismatch: got ' + got + ', expected ' + ZIP_SHA256);
    execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'inherit' });
    fs.mkdirSync(dest, { recursive: true });
    for (const f of FILES) fs.copyFileSync(path.join(tmp, 'platform-tools', f), path.join(dest, f));
    for (const f of ['NOTICE.txt', 'source.properties']) {
      const from = path.join(tmp, 'platform-tools', f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, f));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

module.exports = { fetchAdb };

if (require.main === module) {
  fetchAdb(process.argv[2]).then((d) => console.log('adb is in ' + d), (e) => { console.error(e.message); process.exit(1); });
}
