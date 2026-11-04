// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume here (shared/rezume.js): what is in use in the window in front. The helper's
// frontActivity (Activity.cs) names its .exe and title and reads a browser's address bar; a browser
// it can't read goes through its own files (shared/browsertabs.js); a document is the one Windows
// lists as recently opened under the name the title shows. TwinDesk's own windows and the shell's
// (the taskbar, Start, File Explorer) are nothing to go on with. Anything else is at least the app
// itself (kind 'app'), whose window ReZume may send to another computer.
'use strict';

const path = require('path');
const tabs = require('../shared/browsertabs.js');

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
      const t = tabs.splitTitle(r.title);
      const appName = NAMES[base] || t.app || path.basename(exe, '.exe');
      if (r.browser) {
        const url = r.url || (tabs.tabOf(base, r.title) || {}).url;
        return url ? { kind: 'web', url, title: t.page, app: exe, appName } : null; // a browser: its link only
      } else if (r.file) return { kind: 'doc', path: r.file, title: path.basename(r.file), app: exe, appName };
      return { kind: 'app', title: r.title || appName, app: exe, appName };
    },
    async appIcon(exe) {
      const { app } = require('electron');
      const img = await app.getFileIcon(exe, { size: 'large' });
      return img && !img.isEmpty() ? img.toDataURL() : '';
    },
  };
}

module.exports = { create };
