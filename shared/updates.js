// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Update check for all three apps: asks GitHub for the latest release of TwinDesk, compares its
// tag with this app's version and picks the download for this platform and CPU. Nothing is
// installed here; the app opens the download (or the release page) in the browser.
//
// new Updates({ current, platform: 'mac'|'win'|'linux', getSettings, save, notify, onChange })
//   settings.updates = { auto, notified }: check on start and every 6 hours when auto is on;
//   notify(title, body, onClick) once per new version; open() shows the download in the browser.
'use strict';

const REPO = 'InukaAsith/TwinDesk';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${REPO}/releases`;
const FIRST_DELAY = 15 * 1000;
const EVERY = 6 * 60 * 60 * 1000;

// "v1.2.3" / "1.2" / "1.2.3-beta.1" -> {nums: [1,2,3], pre: 'beta.1'}; null when it isn't a version.
function parse(v) {
  const m = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: m[1].split('.').map(Number), pre: m[2] || '' };
}

// > 0 when a is newer than b. A pre-release is older than the same version without one.
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const ARCH_WORDS = {
  arm64: /arm64|aarch64|apple|silicon|universal/i,
  x64: /x64|x86_64|amd64|intel|universal/i,
  ia32: /ia32|x86(?!_64)|i386|i686/i,
};
const OTHER_ARCH = {
  arm64: /x64|x86_64|amd64|intel|ia32|i386|i686/i,
  x64: /arm64|aarch64|armv7|ia32|i386|i686/i,
  ia32: /arm64|aarch64|x64|x86_64|amd64/i,
};

// The best download for this computer from a release's assets, or null.
function pickAsset(assets, platform, arch, prefer) {
  const kinds = {
    mac: [/\.dmg$/i, /(mac|darwin|osx).*\.zip$/i],
    win: [/setup.*\.exe$/i, /\.exe$/i, /\.msi$/i],
    linux: prefer === 'deb' ? [/\.deb$/i, /\.AppImage$/i] : [/\.AppImage$/i, /\.deb$/i],
  }[platform] || [];
  const list = (assets || []).filter((a) => a && a.name && a.browser_download_url);
  for (const kind of kinds) {
    const fit = list.filter((a) => kind.test(a.name));
    if (!fit.length) continue;
    const mine = fit.find((a) => ARCH_WORDS[arch] && ARCH_WORDS[arch].test(a.name));
    const neutral = fit.find((a) => !(OTHER_ARCH[arch] || /$^/).test(a.name));
    const a = mine || neutral;
    if (a) return { name: a.name, url: a.browser_download_url, size: a.size || 0 };
  }
  return null;
}

function defaultFetch() {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return (url, opts) => net.fetch(url, opts); // system proxy
  } catch (_) { /* not in Electron */ }
  return (url, opts) => fetch(url, opts);
}

class Updates {
  constructor(opts) {
    this.current = opts.current;
    this.platform = opts.platform;
    this.arch = opts.arch || process.arch;
    this.prefer = opts.prefer || '';
    this.getSettings = opts.getSettings;
    this.save = opts.save || (() => {});
    this.notify = opts.notify || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.fetch = opts.fetch || defaultFetch();
    this.openUrl = opts.openUrl || ((url) => require('electron').shell.openExternal(url));
    this.status = { checking: false, latest: null, name: '', available: false, error: '', checkedAt: 0,
      releaseUrl: RELEASES, download: null, noReleases: false };
    this.timer = null;
    this.first = null;
  }

  get cfg() {
    const s = this.getSettings();
    if (!s.updates || typeof s.updates !== 'object') s.updates = { auto: true, notified: '' };
    return s.updates;
  }

  // Start (or stop) the automatic checks after the setting changed.
  start() {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.first = null;
    this.timer = null;
    if (this.cfg.auto === false) return;
    this.first = setTimeout(() => this.check(false), FIRST_DELAY);
    this.timer = setInterval(() => this.check(false), EVERY);
    if (this.timer.unref) this.timer.unref();
  }

  async check(manual = true) {
    if (this.status.checking) return;
    this._set({ checking: true, error: '' });
    try {
      const res = await this.fetch(API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `TwinDesk/${this.current}` },
        cache: 'no-store',
      });
      if (res.status === 404) {
        return this._set({ checking: false, latest: null, name: '', available: false, download: null,
          releaseUrl: RELEASES, noReleases: true, checkedAt: Date.now() });
      }
      if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is busy, try again later' : `GitHub answered ${res.status}`);
      const r = await res.json();
      const latest = String(r.tag_name || r.name || '').replace(/^v/i, '');
      if (!parse(latest)) throw new Error('The latest release has no version number');
      const available = compare(latest, this.current) > 0;
      const download = pickAsset(r.assets, this.platform, this.arch, this.prefer);
      this._set({ checking: false, latest, name: String(r.name || `TwinDesk ${latest}`), available, download,
        releaseUrl: r.html_url || RELEASES, noReleases: false, checkedAt: Date.now() });
      if (available && this.cfg.notified !== latest) {
        this.cfg.notified = latest;
        this.save();
        this.notify(`TwinDesk ${latest} is available`, manual ? 'Click to download it.' : `You have ${this.current}. Click to download the new version.`, () => this.open());
      }
    } catch (e) {
      this._set({ checking: false, error: manual ? (e && e.message) || 'Couldn’t reach GitHub' : '', checkedAt: this.status.checkedAt });
    }
  }

  // The URL to open for "Download": this platform's file, else the release page.
  get url() {
    return this.status.available && this.status.download ? this.status.download.url : this.status.releaseUrl;
  }

  open() {
    this.openUrl(this.url);
  }

  _set(fields) {
    Object.assign(this.status, fields);
    this.onChange();
  }

  get view() {
    return { current: this.current, auto: this.cfg.auto !== false, ...this.status };
  }
}

module.exports = { Updates, compare, pickAsset, parse, REPO };
