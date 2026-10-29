// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Stages frontend UI assets (shared, windows, mac) into dist-tauri for Tauri packaging.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist-tauri');

if (fs.existsSync(out)) {
  fs.rmSync(out, { recursive: true, force: true });
}
fs.mkdirSync(out, { recursive: true });

function copyDir(src, dest, filter) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (filter && !filter(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const webFilter = (_p, entry) => {
  if (entry.isDirectory()) {
    const name = entry.name;
    return name !== 'node_modules' && name !== 'test' && name !== 'installer';
  }
  return /\.(html|js|css|png|svg|jpg|jpeg|ico|icns|json)$/i.test(entry.name);
};

copyDir(path.join(root, 'shared'), path.join(out, 'shared'), webFilter);
copyDir(path.join(root, 'windows'), path.join(out, 'windows'), webFilter);
copyDir(path.join(root, 'mac'), path.join(out, 'mac'), webFilter);

const indexHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=windows/app.html">
  <title>TwinDesk</title>
</head>
<body>
  <script>window.location.replace("windows/app.html");</script>
</body>
</html>`;
fs.writeFileSync(path.join(out, 'index.html'), indexHtml, 'utf8');

console.log('[stage-tauri-ui] Staged frontend into ' + out);
