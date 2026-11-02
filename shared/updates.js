// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Update check for all three apps: asks GitHub for the latest release of TwinDesk, compares its
// tag with this app's version and picks the download for this platform and CPU. Nothing is
// installed here; the app opens the download (or the release page) in the browser.
//
// new Updates({ current, platform: 'mac'|'win'|'linux', getSettings, save, notify, onChange, getLanguage })
//   settings.updates = { auto, notified }: check on start and every 6 hours when auto is on;
//   notify(title, body, onClick) once per new version; open() shows the download in the browser.
'use strict';

const I18n = require('./i18n.js');
const REPO = 'InukaAsith/TwinDesk';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${REPO}/releases`;
const FIRST_DELAY = 15 * 1000;
const EVERY = 6 * 60 * 60 * 1000;
const CHECK_MS = 15000;

// Escape HTML entities to prevent any injection in release notes.
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Convert GitHub markdown release notes into clean, safe HTML for the in-app updater.
function formatReleaseNotes(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return '<p class="updater-empty-notes">No release notes provided for this version.</p>';
  }

  const lines = raw.split(/\r?\n/);
  const html = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  const formatInline = (text) => {
    let s = escapeHtml(text);
    // Inline code `...`
    s = s.replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
    // Bold **...**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic *...*
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // PR / issue references #123
    s = s.replace(/(^|[\s(])#(\d+)([\s),.]|$)/g, '$1<span class="updater-issue">#$2</span>$3');
    // User mentions @username
    s = s.replace(/(^|[\s(])@([a-zA-Z0-9_-]+)([\s),.]|$)/g, '$1<span class="updater-mention">@$2</span>$3');
    // Links stay text: this window doesn't open new windows, so a click would open a bare one
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      closeList();
      continue;
    }

    // Headings: #, ##, ###, ####
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      closeList();
      const level = Math.min(hMatch[1].length + 2, 5); // ### -> h5, ## -> h4
      html.push(`<h${level} class="updater-heading">${formatInline(hMatch[2])}</h${level}>`);
      continue;
    }

    // List item: - or *
    const liMatch = line.match(/^[-*]\s+(.+)$/);
    if (liMatch) {
      if (!inList) {
        html.push('<ul class="updater-list">');
        inList = true;
      }
      html.push(`<li>${formatInline(liMatch[1])}</li>`);
      continue;
    }

    // Paragraph
    closeList();
    html.push(`<p class="updater-p">${formatInline(line)}</p>`);
  }

  closeList();
  return html.join('\n');
}

// "v1.2.3" / "1.2" / "1.2.3-beta.1" -> {nums: [1,2,3], pre: 'beta.1'}; null when it isn't a version.
function parse(v) {
  const m = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(String(v || '').trim());
  if (!m) return null;
  const nums = m[1].split('.').map(Number);
  if (!nums.every(Number.isSafeInteger) || (m[2] || '').split('.').some((p) => /^0\d+$/.test(p))) return null;
  return { nums, pre: m[2] || '' };
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
  const aParts = x.pre.split('.');
  const bParts = y.pre.split('.');
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const a = aParts[i], b = bParts[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    if (an && bn) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
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
    this.getLanguage = opts.getLanguage || (() => 'en');
    this.onChange = opts.onChange || (() => {});
    this.fetch = opts.fetch || defaultFetch();
    this.timeoutMs = opts.timeoutMs || CHECK_MS;
    this.openUrl = opts.openUrl || ((url) => require('electron').shell.openExternal(url));
    this.onShowModal = opts.onShowModal || (() => this.open());
    this.status = {
      checking: false,
      latest: null,
      name: '',
      available: false,
      error: '',
      checkedAt: 0,
      releaseUrl: RELEASES,
      releaseNotes: '',
      publishedAt: '',
      download: null,
      noReleases: false,
      skipped: false,
      promptUpdate: false,
    };
    this.timer = null;
    this.first = null;
  }

  get cfg() {
    const s = this.getSettings();
    if (!s.updates || typeof s.updates !== 'object') s.updates = { auto: true, notified: '', skipped: '' };
    if (typeof s.updates.skipped !== 'string') s.updates.skipped = '';
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

  // Skip a specific release so automatic updates don't nag the user again for it.
  skip(version) {
    const v = String(version || this.status.latest || '').replace(/^v/i, '');
    if (!v) return;
    this.cfg.skipped = v;
    this.save();
    this._set({ skipped: this.status.latest === v, promptUpdate: false });
  }

  // Restore skipped updates.
  unskip() {
    this.cfg.skipped = '';
    this.save();
    this._set({ skipped: false });
  }

  // Trigger modal display (from tray, menu, notification, or manual action).
  showModal() {
    this.onShowModal();
  }

  async check(manual = true) {
    if (this.status.checking) return;
    this._set({ checking: true, error: '', promptUpdate: false });
    try {
      const url = `${API}?_=${Date.now()}`;
      const res = await this.fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `TwinDesk/${this.current}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) {
        return this._set({
          checking: false, latest: null, name: '', available: false, download: null,
          releaseUrl: RELEASES, releaseNotes: '', publishedAt: '', noReleases: true,
          checkedAt: Date.now(), skipped: false, promptUpdate: false,
        });
      }
      if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is busy, try again later' : `GitHub answered ${res.status}`);
      const r = await res.json();
      const latest = String(r.tag_name || r.name || '').replace(/^v/i, '');
      if (!parse(latest)) throw new Error('The latest release has no version number');
      const available = compare(latest, this.current) > 0;
      const download = pickAsset(r.assets, this.platform, this.arch, this.prefer);
      const skipped = this.cfg.skipped === latest;
      const isNewVersion = this.cfg.notified !== latest;
      const promptUpdate = available && !skipped && (manual || isNewVersion);

      this._set({
        checking: false,
        latest,
        name: String(r.name || `TwinDesk ${latest}`),
        available,
        download,
        releaseUrl: r.html_url || RELEASES,
        releaseNotes: String(r.body || ''),
        publishedAt: r.published_at || '',
        noReleases: false,
        checkedAt: Date.now(),
        skipped,
        promptUpdate,
      });

      if (available && isNewVersion) {
        this.cfg.notified = latest;
        this.save();
        if (!skipped) {
          const i18n = I18n.create(this.getLanguage());
          this.notify(
            i18n.t('TwinDesk {version} is available', { version: latest }),
            manual ? i18n.t('Click to view update details.') : i18n.t('You have {version}. Click to view update details and release notes.', { version: this.current }),
            () => this.onShowModal(),
          );
        }
      }
    } catch (e) {
      this._set({
        checking: false,
        error: manual ? (e && e.message) || 'Couldn’t reach GitHub' : '',
        checkedAt: this.status.checkedAt,
        promptUpdate: false,
      });
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
    return {
      current: this.current,
      auto: this.cfg.auto !== false,
      skippedVersion: this.cfg.skipped || '',
      ...this.status,
    };
  }
}

module.exports = { Updates, compare, pickAsset, parse, formatReleaseNotes, REPO };
