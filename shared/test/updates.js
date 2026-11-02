// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/updates.js pickAsset: each computer finds its own download among a release's files,
// with the Mac's disk images named TwinDesk-<version>-<arch>.dmg (mac/build-dmg.sh) and as before.
'use strict';

const assert = require('assert');
const { Updates, pickAsset, formatReleaseNotes, compare, parse } = require('../updates.js');

const ordered = ['2.5.0-alpha', '2.5.0-alpha.1', '2.5.0-alpha.beta', '2.5.0-beta', '2.5.0-beta.2', '2.5.0-beta.10', '2.5.0-rc.1', '2.5.0'];
for (let i = 1; i < ordered.length; i++) {
  assert(compare(ordered[i], ordered[i - 1]) > 0, `${ordered[i]} follows ${ordered[i - 1]}`);
  assert(compare(ordered[i - 1], ordered[i]) < 0);
}
assert.strictEqual(compare('v2.4.0+build.10', '2.4.0+build.2'), 0);
for (const invalid of ['2.4.0junk', '2.4.0-beta..1', '2.4.0-', '2.4.0.1.2', '2.4.0-beta.01']) assert.strictEqual(parse(invalid), null, invalid);

const files = (...names) => names.map((name) => ({ name, browser_download_url: 'https://example.invalid/' + name, size: 1 }));
const pick = (assets, platform, arch, prefer) => (pickAsset(assets, platform, arch, prefer) || {}).name || null;
const OTHERS = ['TwinDesk-2.3.0-amd64.deb', 'TwinDesk-2.3.0-x86_64.AppImage', 'TwinDesk-2.3.0.apk', 'TwinDesk-2.3.0-full.apk',
  'TwinDesk-Setup-2.3.0.exe', 'TwinDesk-Setup-2.3.0-arm64.exe'];

// Versioned, both Macs: each its own.
const both = files(...OTHERS, 'TwinDesk-2.3.0-arm64.dmg', 'TwinDesk-2.3.0-x64.dmg');
assert.strictEqual(pick(both, 'mac', 'arm64'), 'TwinDesk-2.3.0-arm64.dmg');
assert.strictEqual(pick(both, 'mac', 'x64'), 'TwinDesk-2.3.0-x64.dmg');
// The order on the release doesn't matter.
assert.strictEqual(pick(both.slice().reverse(), 'mac', 'arm64'), 'TwinDesk-2.3.0-arm64.dmg');
assert.strictEqual(pick(both.slice().reverse(), 'mac', 'x64'), 'TwinDesk-2.3.0-x64.dmg');
// Only Apple Silicon's on the release yet: an Intel Mac isn't given it (the release page opens instead).
const armOnly = files(...OTHERS, 'TwinDesk-2.3.0-arm64.dmg');
assert.strictEqual(pick(armOnly, 'mac', 'arm64'), 'TwinDesk-2.3.0-arm64.dmg');
assert.strictEqual(pick(armOnly, 'mac', 'x64'), null);
// The names up to 2.2.0 still work.
const old = files(...OTHERS, 'TwinDesk.dmg', 'Twindesk_intel.dmg');
assert.strictEqual(pick(old, 'mac', 'arm64'), 'TwinDesk.dmg');
assert.strictEqual(pick(old, 'mac', 'x64'), 'Twindesk_intel.dmg');
// The other platforms are unaffected by the Mac's names.
assert.strictEqual(pick(both, 'win', 'x64'), 'TwinDesk-Setup-2.3.0.exe');
assert.strictEqual(pick(both, 'win', 'arm64'), 'TwinDesk-Setup-2.3.0-arm64.exe');
assert.strictEqual(pick(both, 'linux', 'x64'), 'TwinDesk-2.3.0-x86_64.AppImage');
assert.strictEqual(pick(both, 'linux', 'x64', 'deb'), 'TwinDesk-2.3.0-amd64.deb');

// Release notes formatting (Quotio-style markdown parser)
const notes = `## What's Changed
* Fix KVM socket backpressure coalescing by @InukaAsith in #54
* Add Homebrew Cask and headless installer by @user in #60
* Performance **improvements** and \`zero-gc\` latency

Check details at https://github.com/InukaAsith/TwinDesk`;

const formatted = formatReleaseNotes(notes);
assert(formatted.includes('<h4 class="updater-heading">What&#39;s Changed</h4>') || formatted.includes('What&#39;s Changed') || formatted.includes('What\'s Changed'));
assert(formatted.includes('<ul class="updater-list">'));
assert(formatted.includes('<span class="updater-mention">@InukaAsith</span>'));
assert(formatted.includes('<span class="updater-issue">#54</span>'));
assert(formatted.includes('<strong>improvements</strong>'));
assert(formatted.includes('<code class="mono">zero-gc</code>'));
assert(formatted.includes('https://github.com/InukaAsith/TwinDesk') && !formatted.includes('<a '));

// HTML escaping verification
const dirty = '## <script>alert(1)</script>\n* <img src=x onerror=alert(2)>';
const safe = formatReleaseNotes(dirty);
assert(!safe.includes('<script>'));
assert(!safe.includes('<img'));
assert(safe.includes('&lt;script&gt;'));
assert(safe.includes('&lt;img'));

// Empty notes fallback
assert(formatReleaseNotes('').includes('No release notes provided'));

// Updates class skip & unskip logic
let savedSettings = { updates: { auto: true, notified: '', skipped: '' } };
let notificationCalled = 0;
let modalCalled = 0;
let changed = 0;

const u = new Updates({
  current: '2.3.0',
  platform: 'win',
  arch: 'x64',
  getSettings: () => savedSettings,
  save: () => {},
  notify: (title, body, onClick) => {
    notificationCalled++;
    if (onClick) onClick();
  },
  onChange: () => { changed++; },
  onShowModal: () => { modalCalled++; },
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v2.4.0',
      name: 'TwinDesk 2.4.0',
      body: notes,
      published_at: '2026-10-27T10:00:00Z',
      html_url: 'https://github.com/InukaAsith/TwinDesk/releases/tag/v2.4.0',
      assets: [{ name: 'TwinDesk-Setup-2.4.0.exe', browser_download_url: 'https://example.invalid/TwinDesk-Setup-2.4.0.exe', size: 1024 }],
    }),
  }),
});

(async () => {
  await u.check(true);
  assert.strictEqual(u.status.available, true);
  assert.strictEqual(u.status.latest, '2.4.0');
  assert.strictEqual(u.status.skipped, false);
  assert.strictEqual(u.status.promptUpdate, true);
  assert.strictEqual(notificationCalled, 1);
  assert.strictEqual(modalCalled, 1);
  assert.strictEqual(u.view.skippedVersion, '');
  assert.strictEqual(u.status.releaseNotes, notes);

  // Skip version 2.4.0
  u.skip('2.4.0');
  assert.strictEqual(savedSettings.updates.skipped, '2.4.0');
  assert.strictEqual(u.status.skipped, true);
  assert.strictEqual(u.view.skippedVersion, '2.4.0');

  // Next check with skipped version will not prompt or notify
  notificationCalled = 0;
  modalCalled = 0;
  await u.check(false);
  assert.strictEqual(notificationCalled, 0);
  assert.strictEqual(modalCalled, 0);
  assert.strictEqual(u.status.skipped, true);
  assert.strictEqual(u.status.promptUpdate, false);

  // Unskip
  u.unskip();
  assert.strictEqual(savedSettings.updates.skipped, '');
  assert.strictEqual(u.status.skipped, false);

  const stalled = new Updates({
    current: '2.4.0', platform: 'win', getSettings: () => savedSettings, timeoutMs: 10,
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('request timed out')), { once: true })),
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await stalled.check(true);
    assert.strictEqual(stalled.status.checking, false);
    assert.match(stalled.status.error, /timed out/);
  } finally { clearTimeout(keepAlive); }

  console.log('updates: ok');
})();
