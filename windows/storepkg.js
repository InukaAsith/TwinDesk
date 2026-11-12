// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Microsoft Store build: the same app, packed as an MSIX (installer/build.js store, its manifest
// installer/store-manifest.xml). What differs from the NSIS install:
//
//   its folder   C:\Program Files\WindowsApps\<package>_<version>_…, read-only and renamed by every
//                update. Anything Windows keeps after this run (Start menu and Send to shortcuts,
//                Explorer's menu, the login item) starts the app's alias instead, which the package
//                keeps (%LOCALAPPDATA%\Microsoft\WindowsApps\TwinDesk.exe), never process.execPath.
//   its identity the package's own app id; toasts, the calls' phone line (callaudio.js) and twindesk:
//                links (declared in the manifest) go with it.
//   updates      only the Store's (shared/updates.js: store).
// Files and the registry are not virtualized (desktop6 in the manifest): settings stay in
// %APPDATA%\MacShare, shared with an NSIS install of TwinDesk on the same PC.
'use strict';

const path = require('path');

const STORE = process.windowsStore === true;
const FAMILY = 'InukaAsith.TwinDesk_8367xdfax9nq8'; // Partner Center › Product identity
const AUMID = FAMILY + '!TwinDesk'; // the manifest's Application Id

// What a shortcut, a menu or the login item should start.
function launcher() {
  if (!STORE) return process.execPath;
  const local = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  return path.join(local, 'Microsoft', 'WindowsApps', 'TwinDesk.exe');
}

module.exports = { STORE, FAMILY, AUMID, launcher };
