// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume here (shared/rezume.js): what is in use in the window in front. The helper's
// frontActivity (Activity.cs) names its .exe and title and reads a browser's address bar; a browser
// it can't read goes through its own files (shared/browsertabs.js); a document is the one Windows
// lists as recently opened under the name the title shows. TwinDesk's own windows and the shell's
// (the taskbar, Start, File Explorer) are nothing to go on with. Anything else is at least the app
// itself (kind 'app'), whose window ReZume may send to another computer. A browser showing a local
// file (a PDF) offers that file as a document; a player or Photos that went on to the next file is
// found next to Recent's newest files, VLC by its own list (shared/docfind.js).
'use strict';

const fs = require('fs');
const path = require('path');
const tabs = require('../shared/browsertabs.js');
const docfind = require('../shared/docfind.js');

const SHELL = /\\(explorer|SearchHost|SearchApp|ShellExperienceHost|StartMenuExperienceHost|LockApp|TextInputHost|ApplicationFrameHost|SystemSettings|Taskmgr)\.exe$/i;
const NAMES = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox', brave: 'Brave', vivaldi: 'Vivaldi', opera: 'Opera', chromium: 'Chromium' };

function create({ helper, selfExe }) {
  const self = String(selfExe || process.execPath).toLowerCase();
  return {
    async detect() {
      const r = await helper.request('frontActivity', {}, 4000);
      const exe = r && typeof r.exe === 'string' ? r.exe : '';
      if (!exe || exe.toLowerCase() === self || SHELL.test(exe)) return null;
      const base = path.basename(exe, '.exe').toLowerCase();
      const title = docfind.clean(r.title);
      const t = tabs.splitTitle(title);
      const appName = NAMES[base] || t.app || path.basename(exe, '.exe');
      const doc = (p) => ({ kind: 'doc', path: p, title: path.basename(p), app: exe, appName });
      if (r.browser) {
        if (r.file) return doc(r.file); // a local file in the browser: a PDF
        const url = r.url || (tabs.tabOf(base, title) || {}).url;
        const local = docfind.fileUrlPath(url, 'win32');
        if (local) return fs.existsSync(local) ? doc(local) : null;
        return url ? { kind: 'web', url, title: t.page, app: exe, appName } : null; // a browser: its link only
      }
      const file = r.file || docfind.playerFile(exe, title, 'win32') || docfind.inFolders(title, Array.isArray(r.dirs) ? r.dirs : []);
      if (file) return doc(file);
      return { kind: 'app', title: title || appName, app: exe, appName };
    },
    async appIcon(exe) {
      const { app } = require('electron');
      const img = await app.getFileIcon(exe, { size: 'large' });
      return img && !img.isEmpty() ? img.toDataURL() : '';
    },
  };
}

module.exports = { create };
