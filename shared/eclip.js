// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Electron's clipboard, before and after 44. Electron 44 took out availableFormats, readBuffer,
// writeBuffer, readImage and writeImage: what's on the clipboard is read() (ClipboardItems, each
// with its types), and an OS format without a MIME type is `electron application/osclipboard;format="X"`.
// Every function here takes the clipboard and works on both, so the callers don't care which.
'use strict';

const RAW = (format) => `electron application/osclipboard;format="${format}"`;
const RAW_RE = /^electron application\/osclipboard;format="(.*)"$/;

// One look at the clipboard: its formats (bare names, as availableFormats gave them) and a format's
// bytes. One read() for all of them, where the old API needed none.
async function snapshot(clipboard) {
  if (typeof clipboard.readBuffer === 'function') { // before 44, and linux/wlclip.js (each a Promise there)
    const formats = typeof clipboard.availableFormats === 'function' ? (await clipboard.availableFormats()) || [] : [];
    return { formats, raw: async (f) => Buffer.from((await clipboard.readBuffer(f)) || []) };
  }
  let items = [];
  try { items = await clipboard.read(); } catch (_) { /* nothing readable on it */ }
  const formats = [...new Set(items.flatMap((i) => i.types.map((t) => (RAW_RE.exec(t) || [, t])[1])))];
  const raw = async (f) => {
    for (const item of items) {
      const t = item.types.includes(f) ? f : item.types.includes(RAW(f)) ? RAW(f) : null;
      if (!t) continue;
      try { return Buffer.from(await (await item.getType(t)).arrayBuffer()); } catch (_) { return Buffer.alloc(0); }
    }
    return Buffer.alloc(0);
  };
  return { formats, raw };
}

async function formats(clipboard) {
  return (await snapshot(clipboard)).formats;
}

async function hasImage(clipboard) {
  return (await formats(clipboard)).some((f) => /^image\//.test(f));
}

// Password managers mark secrets so clipboard tools leave them alone. clipboard.has() doesn't see
// these registered formats; their bytes do (none = format absent).
async function isConcealed(clipboard) {
  try {
    const s = await snapshot(clipboard);
    if ((await s.raw('ExcludeClipboardContentFromMonitorProcessing')).length) return true;
    if ((await s.raw('Clipboard Viewer Ignore')).length) return true;
    const b = await s.raw('CanIncludeInClipboardHistory');
    if (b && b.length >= 4 && b.readUInt32LE(0) === 0) return true;
    // KDE's, which KeePassXC and other Linux password managers set to "secret"
    if (s.formats.includes('x-kde-passwordManagerHint') && /secret/i.test((await s.raw('x-kde-passwordManagerHint')).toString('utf8'))) return true;
  } catch (_) { /* unknown format: not concealed */ }
  return false;
}

module.exports = { snapshot, formats, hasImage, isConcealed, RAW };
