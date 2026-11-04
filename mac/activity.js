// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume here (shared/rezume.js): what is in use in the app in front. One JavaScript for
// Automation run (osascript) a look: the front app from NSWorkspace (nothing to allow); a browser's
// tab from the browser itself (Safari, Chrome, Edge, Brave, Vivaldi, Opera, Arc: macOS asks once per
// browser, "TwinDesk wants to control …"); any other app's document from its window's AXDocument
// through System Events (Accessibility, which TwinDesk has for the mouse and keyboard, and System
// Events' Automation, asked once). Firefox has no scripting: its window's title, then its own
// session file (shared/browsertabs.js). Anything else is at least the app itself (kind 'app'), whose
// window ReZume may send to another computer. Nothing runs before ReZume is on.
'use strict';

const { execFile } = require('child_process');
const tabs = require('../shared/browsertabs.js');

const CHROMIUMS = ['com.google.Chrome', 'com.google.Chrome.beta', 'com.microsoft.edgemac', 'com.brave.Browser', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera', 'company.thebrowser.Browser', 'org.chromium.Chromium'];
const SKIP = /^(com\.apple\.(finder|dock|loginwindow|systemuiserver|controlcenter|notificationcenterui|Spotlight|systempreferences)|org\.macshare\.|com\.twindesk\.|com\.github\.Electron)/;

const SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const docs = argv[0] === '1';
  const chromiums = ${JSON.stringify(CHROMIUMS)};
  const fa = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!fa || fa.isNil()) return 'null';
  const id = ObjC.unwrap(fa.bundleIdentifier) || '';
  const out = { id: id, name: ObjC.unwrap(fa.localizedName) || '', pid: fa.processIdentifier, path: fa.bundleURL.isNil() ? '' : ObjC.unwrap(fa.bundleURL.path) || '' };
  if (${SKIP}.test(id)) { out.skip = true; return JSON.stringify(out); }
  try {
    if (/^com\\.apple\\.Safari/.test(id)) {
      const t = Application(id).windows[0].currentTab;
      out.url = t.url(); out.title = t.name(); out.browser = true;
    } else if (chromiums.indexOf(id) >= 0) {
      const t = Application(id).windows[0].activeTab;
      out.url = t.url(); out.title = t.title(); out.browser = true;
    }
  } catch (e) { out.err = String(e); out.browser = true; }
  if (!out.url && (docs || /firefox|librewolf|zen/i.test(id))) {
    try {
      const p = Application('System Events').processes.whose({ unixId: out.pid })[0];
      const w = p.windows[0];
      out.title = out.title || w.name();
      if (docs) { try { out.doc = w.attributes.byName('AXDocument').value(); } catch (e) {} }
    } catch (e) { out.serr = String(e); }
  }
  return JSON.stringify(out);
}`;

const jxa = (docs) => new Promise((resolve) => {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, docs ? '1' : '0'], { timeout: 5000 }, (err, out) => {
    if (err) return resolve(null);
    try { resolve(JSON.parse(String(out).trim() || 'null')); } catch (_) { resolve(null); }
  });
});

// An app's own icon, 64 px PNG in base64 (as the helper's Apps.icon). Not app.getFileIcon: on macOS
// it goes by the extension alone, so every .app got the blank app icon.
const ICON = `
ObjC.import('AppKit');
function run(argv) {
  let file = argv[0];
  if (file.charAt(0) !== '/') { // a bundle id (an app on ReZume's lists, from before a restart)
    const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(file);
    if (!u || u.isNil()) return '';
    file = ObjC.unwrap(u.path);
  }
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(file);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 64, 64, 8, 4, true, false, 'NSDeviceRGBColorSpace', 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSMakeRect(0, 0, 0, 0), 2, 1); // the whole image, source-over
  $.NSGraphicsContext.restoreGraphicsState;
  return rep.representationUsingTypeProperties(4, $({})).base64EncodedStringWithOptions(0).js; // PNG
}`;

const iconOf = (p) => new Promise((resolve) => {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ICON, p], { timeout: 5000 }, (err, out) => {
    const b64 = err ? '' : String(out).trim();
    resolve(/^[A-Za-z0-9+/=]{100,}$/.test(b64) ? 'data:image/png;base64,' + b64 : '');
  });
});

// "Not authorized to send Apple events" (-1743): Automation was refused for that app.
const refused = (e) => /-1743|not authori[sz]ed|not allowed assistive/i.test(String(e || ''));

function create({ cfg }) {
  const paths = new Map(); // bundle id → its .app, for its icon
  return {
    async detect() {
      const r = await jxa(!!cfg().docs);
      if (!r || r.skip || !r.id) return null;
      if (r.path) paths.set(r.id, r.path);
      const app = r.id;
      const appName = r.name;
      if (r.browser || /firefox|librewolf|zen/i.test(app)) {
        if (refused(r.err)) return { why: 'Let TwinDesk control ' + appName + ' to offer its tabs: System Settings › Privacy & Security › Automation › TwinDesk' };
        const url = r.url || (tabs.tabOf(app, r.title || '') || {}).url;
        return url ? { kind: 'web', url, title: tabs.splitTitle(r.title || '').page || r.title || url, app, appName } : null; // a browser: its link only
      }
      if (refused(r.serr)) return { why: 'Let TwinDesk control System Events to offer documents: System Settings › Privacy & Security › Automation › TwinDesk' };
      if (typeof r.doc === 'string' && r.doc.startsWith('file://')) {
        let p = '';
        try { p = decodeURIComponent(new URL(r.doc).pathname); } catch (_) { p = ''; }
        if (p) return { kind: 'doc', path: p, title: require('path').basename(p), app, appName };
      }
      return { kind: 'app', title: r.title || appName, app, appName };
    },
    async appIcon(app) {
      const p = paths.get(app) || (/^[A-Za-z0-9.-]{1,200}$/.test(app) ? app : '');
      return p ? iconOf(p) : '';
    },
    stop() {},
  };
}

module.exports = { create };
