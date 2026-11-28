// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Finder's right-click › Quick Actions › Share folder (TwinDesk), on folders: a Quick Action in
// ~/Library/Services (an Automator service, as macOS makes them) that opens
// macshare://share-folder?h=<the folder's path in hex> for each folder chosen; main.js takes it
// (open-url) and opens the Share <folder> with… sheet (shared/folders-host.js): which devices get it.
// The path goes as hex so the script needs no quoting; it runs nothing but /usr/bin/open. Written at
// start when it isn't there or differs (the app's bundle id may change), and switched off in
// System Settings › Keyboard › Keyboard Shortcuts › Services like any other.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'Share folder (TwinDesk)';
const OLD_NAMES = ['Share with phone (TwinDesk)']; // its name before shared folders: removed
const DIR = path.join(os.homedir(), 'Library', 'Services', `${NAME}.workflow`, 'Contents');
const UUIDS = ['8C1F0B9E-2D4A-4F3B-9A61-3E5D7C2B1A01', '8C1F0B9E-2D4A-4F3B-9A61-3E5D7C2B1A02', '8C1F0B9E-2D4A-4F3B-9A61-3E5D7C2B1A03'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n';

// What the Quick Action runs, each chosen item as an argument (inputMethod 1). cmd: the opener (tests swap it).
function script(cmd = '/usr/bin/open -g') {
  return `for f in "$@"; do\n  [ -d "$f" ] || continue\n  ${cmd} "macshare://share-folder?h=$(/usr/bin/printf %s "$f" | /usr/bin/xxd -p | /usr/bin/tr -d '\\n')"\ndone\n`;
}

function infoPlist() {
  return `${HEAD}<dict>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSBackgroundColorName</key><string>background</string>
\t\t\t<key>NSIconName</key><string>NSActionTemplate</string>
\t\t\t<key>NSMenuItem</key><dict><key>default</key><string>${esc(NAME)}</string></dict>
\t\t\t<key>NSMessage</key><string>runWorkflowAsService</string>
\t\t\t<key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
\t\t\t<key>NSSendFileTypes</key><array><string>public.folder</string></array>
\t\t</dict>
\t</array>
</dict>
</plist>
`;
}

function workflow(cmd) {
  const [action, input, output] = UUIDS;
  return `${HEAD}<dict>
\t<key>AMApplicationBuild</key><string>523</string>
\t<key>AMApplicationVersion</key><string>2.10</string>
\t<key>AMDocumentVersion</key><string>2</string>
\t<key>actions</key>
\t<array>
\t\t<dict>
\t\t\t<key>action</key>
\t\t\t<dict>
\t\t\t\t<key>AMAccepts</key>
\t\t\t\t<dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
\t\t\t\t<key>AMActionVersion</key><string>2.0.3</string>
\t\t\t\t<key>AMApplication</key><array><string>Automator</string></array>
\t\t\t\t<key>AMParameterProperties</key>
\t\t\t\t<dict><key>COMMAND_STRING</key><dict/><key>CheckedForUserDefaultShell</key><dict/><key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/></dict>
\t\t\t\t<key>AMProvides</key>
\t\t\t\t<dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
\t\t\t\t<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
\t\t\t\t<key>ActionName</key><string>Run Shell Script</string>
\t\t\t\t<key>ActionParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key><string>${esc(script(cmd))}</string>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key><true/>
\t\t\t\t\t<key>inputMethod</key><integer>1</integer>
\t\t\t\t\t<key>shell</key><string>/bin/sh</string>
\t\t\t\t\t<key>source</key><string></string>
\t\t\t\t</dict>
\t\t\t\t<key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
\t\t\t\t<key>CFBundleVersion</key><string>2.0.3</string>
\t\t\t\t<key>CanShowSelectedItemsWhenRun</key><false/>
\t\t\t\t<key>CanShowWhenRun</key><true/>
\t\t\t\t<key>Category</key><array><string>AMCategoryUtilities</string></array>
\t\t\t\t<key>Class Name</key><string>RunShellScriptAction</string>
\t\t\t\t<key>InputUUID</key><string>${input}</string>
\t\t\t\t<key>OutputUUID</key><string>${output}</string>
\t\t\t\t<key>UUID</key><string>${action}</string>
\t\t\t\t<key>UnlocalizedApplications</key><array><string>Automator</string></array>
\t\t\t\t<key>isViewVisible</key><integer>1</integer>
\t\t\t</dict>
\t\t\t<key>isViewVisible</key><integer>1</integer>
\t\t</dict>
\t</array>
\t<key>connectors</key><dict/>
\t<key>workflowMetaData</key>
\t<dict>
\t\t<key>applicationBundleIDsByPath</key><dict/>
\t\t<key>applicationPaths</key><array/>
\t\t<key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
\t\t<key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
\t\t<key>presentationMode</key><integer>15</integer>
\t\t<key>processesInput</key><false/>
\t\t<key>serviceApplicationBundleID</key><string>com.apple.finder</string>
\t\t<key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
\t\t<key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
\t\t<key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
\t\t<key>serviceProcessesInput</key><false/>
\t\t<key>systemImageName</key><string>NSActionTemplate</string>
\t\t<key>useAutomaticInputType</key><false/>
\t\t<key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
\t</dict>
</dict>
</plist>
`;
}

// The Quick Action in place (dir: where, for tests). True when it was written now.
function install({ dir = DIR, cmd } = {}) {
  if (dir === DIR) for (const n of OLD_NAMES) { try { fs.rmSync(path.join(os.homedir(), 'Library', 'Services', `${n}.workflow`), { recursive: true, force: true }); } catch {} }
  const files = { 'Info.plist': infoPlist(), 'document.wflow': workflow(cmd) };
  let wrote = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const f = path.join(dir, name);
      let old = '';
      try { old = fs.readFileSync(f, 'utf8'); } catch {}
      if (old !== text) { fs.writeFileSync(f, text); wrote = true; }
    }
  } catch (e) {
    console.warn('[finder] Quick Action:', e.message);
  }
  return wrote;
}

module.exports = { install, script, NAME };
