// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The mixer's "This computer" row: the speakers' volume here, through the Deck's way into the system
// (shared/deck-sys.js: the helper on Windows and the Mac, pactl on Linux). Loaded when the Audio page
// first asks; nothing runs in between.
'use strict';

let sys = null;

// level: 0–1 to set it, else only read. → {volume, muted} (volume null when it can't be read)
async function volume(platform, helper, level) {
  if (!sys) sys = require('./deck-sys.js').sys(platform, { helper, press: () => {} });
  if (typeof level === 'number' && Number.isFinite(level)) await sys.volume({ input: false, level: Math.max(0, Math.min(1, level)) });
  const a = await sys.audio().catch(() => ({}));
  return { volume: typeof a.volume === 'number' ? a.volume : null, muted: !!a.muted };
}

module.exports = { volume };
