// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Updates for all three desktop apps: asks GitHub for new releases of the repository this build came
// from, compares their tags with this app's version, downloads the file for this platform and CPU
// and hands it to the installer (updates-install.js), which replaces the app and starts it again.
//
// Where the releases come from: the build records its own repository (shared/update-source.json,
// written by the installer builds from GITHUB_REPOSITORY). A build from the main project follows the
// main project's releases, one from a fork follows that fork's; a build without the file (a checkout)
// follows DEFAULT_REPO. Channels: 'stable' = the latest full release, 'beta' = the newest release of
// any kind, pre-releases included (a pre-release build starts on beta).
//
// new Updates({ current, platform: 'mac'|'win'|'linux', getSettings, save, notify, onChange,
//               canInstall, idle, quit })
//   settings.updates = { auto, channel, install: 'ask'|'auto', notified }: check on start and every
//   6 hours when auto is on; notify(title, body, onClick) once per new version; open() shows the
//   download in the browser; install() downloads (if needed), replaces the app and relaunches it.
//   Nothing in the user's data folder is touched, so settings, pairings and the permissions
//   macOS/Windows/Android hold for the app all carry over.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_REPO = 'InukaAsith/TwinDesk';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FIRST_DELAY = 15 * 1000;
const EVERY = 6 * 60 * 60 * 1000;
const LIST_SIZE = 30;

// The repository this build follows: shared/update-source.json ({ "repo": "owner/name" }) or the default.
function readSource(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file || path.join(__dirname, 'update-source.json'), 'utf8'));
    if (j && typeof j.repo === 'string' && REPO_RE.test(j.repo.trim())) return j.repo.trim();
  } catch (_) { /* a checkout, or an older build: the default */ }
  return DEFAULT_REPO;
}

// "v1.2.3" / "1.2" / "1.2.3-beta.1" / "2.1.10-pr1" -> {nums: [1,2,3], pre: 'beta.1'}; null when it isn't a version.
function parse(v) {
  const m = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: m[1].split('.').map(Number), pre: m[2] || '' };
}

// Pre-release labels compare piece by piece, numbers as numbers: pr2 < pr10, beta.1 < beta.2.
function comparePre(a, b) {
  const x = a.match(/\d+|[^\d.]+/g) || [];
  const y = b.match(/\d+|[^\d.]+/g) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) {
      const d = Number(x[i]) - Number(y[i]);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
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
  return comparePre(x.pre, y.pre);
}

// 'stable' | 'beta': the setting, else beta for a pre-release build and stable for the rest.
function channelFor(setting, current) {
  if (setting === 'beta' || setting === 'stable') return setting;
  const p = parse(current);
  return p && p.pre ? 'beta' : 'stable';
}

// The release to offer from a releases list (any order): never a draft; stable skips pre-releases;
// the highest version wins, so beta never offers something older than the stable one.
function pickRelease(list, channel) {
  let best = null;
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || r.draft || !parse(r.tag_name || r.name)) continue;
    if (channel !== 'beta' && r.prerelease) continue;
    const v = String(r.tag_name || r.name).replace(/^v/i, '');
    if (!best || compare(v, best.version) > 0) best = { version: v, release: r };
  }
  return best;
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
    if (a) return { name: a.name, url: a.browser_download_url, size: a.size || 0, digest: typeof a.digest === 'string' ? a.digest : '' };
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
    this.repo = opts.repo || readSource(opts.sourceFile);
    this.dir = opts.dir || path.join(os.tmpdir(), 'twindesk-update');
    this.canInstall = opts.canInstall !== false; // false: a checkout, not an installed app
    this.idle = opts.idle || (() => true); // true when restarting the app costs nothing (no shared input)
    this.quit = opts.quit || (() => {});
    this.launch = opts.launch || ((plan) => require('./updates-install.js').run(plan));
    this.pid = opts.pid || process.pid;
    this.execPath = opts.execPath || process.execPath;
    this.status = { checking: false, latest: null, name: '', available: false, error: '', checkedAt: 0,
      releaseUrl: `https://github.com/${this.repo}/releases`, download: null, noReleases: false,
      prerelease: false, state: 'idle', progress: 0, file: '' };
    this.timer = null;
    this.first = null;
  }

  get cfg() {
    const s = this.getSettings();
    if (!s.updates || typeof s.updates !== 'object') s.updates = { auto: true, notified: '' };
    return s.updates;
  }

  get channel() {
    return channelFor(this.cfg.channel, this.current);
  }

  get api() {
    return this.channel === 'beta'
      ? `https://api.github.com/repos/${this.repo}/releases?per_page=${LIST_SIZE}`
      : `https://api.github.com/repos/${this.repo}/releases/latest`;
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
    if (this.status.checking || this.status.state === 'downloading' || this.status.state === 'installing') return;
    this._set({ checking: true, error: '' });
    try {
      const res = await this.fetch(this.api, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `TwinDesk/${this.current}` },
        cache: 'no-store',
      });
      const home = `https://github.com/${this.repo}/releases`;
      const none = () => this._set({ checking: false, latest: null, name: '', available: false, download: null,
        releaseUrl: home, noReleases: true, checkedAt: Date.now() });
      if (res.status === 404) return none();
      if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is busy, try again later' : `GitHub answered ${res.status}`);
      const body = await res.json();
      const picked = this.channel === 'beta' ? pickRelease(body, 'beta') : pickRelease([body], 'stable');
      if (!picked) {
        if (Array.isArray(body) && !body.length) return none();
        throw new Error('The latest release has no version number');
      }
      const r = picked.release;
      const latest = picked.version;
      const available = compare(latest, this.current) > 0;
      const download = pickAsset(r.assets, this.platform, this.arch, this.prefer);
      const fresh = latest !== this.status.latest;
      this._set({ checking: false, latest, name: String(r.name || `TwinDesk ${latest}`), available, download,
        prerelease: !!r.prerelease, releaseUrl: r.html_url || home, noReleases: false, checkedAt: Date.now(),
        ...(fresh && this.status.state !== 'idle' ? { state: 'idle', progress: 0, file: '' } : {}) });
      if (available && this.cfg.notified !== latest) {
        this.cfg.notified = latest;
        this.save();
        const beta = r.prerelease ? ' (beta)' : '';
        this.notify(`TwinDesk ${latest}${beta} is available`, manual ? 'Click to update.' : `You have ${this.current}. Click to update.`, () => this.act());
      }
      if (available && this.cfg.install === 'auto' && this.canInstall && download && this.idle()) this.install().catch(() => {});
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

  // What a click on the notification or the menu item does: update in place when that is possible.
  act() {
    if (this.canInstall && this.status.available && this.status.download) return this.install().catch(() => {});
    return this.open();
  }

  // Download the offered file into the update folder (a partial or older one is replaced); resolves to its path.
  async download() {
    const d = this.status.download;
    if (!this.status.available || !d) throw new Error('No update to download');
    if (this.status.state === 'ready' && this.status.file && fs.existsSync(this.status.file)) return this.status.file;
    if (this.status.state === 'downloading') throw new Error('Already downloading');
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, d.name.replace(/[^\w.-]/g, '_'));
    this._set({ state: 'downloading', progress: 0, file: '', error: '' });
    try {
      const res = await this.fetch(d.url, { headers: { 'User-Agent': `TwinDesk/${this.current}`, Accept: 'application/octet-stream' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`The download answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || d.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      let got = 0;
      let lastTick = 0;
      await new Promise((resolve, reject) => {
        out.on('error', reject);
        out.on('finish', resolve);
        const reader = res.body.getReader();
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) return out.end();
          got += value.length;
          hash.update(value);
          const ok = out.write(value);
          const now = Date.now();
          if (total && now - lastTick > 250) {
            lastTick = now;
            this._set({ progress: Math.min(1, got / total) });
          }
          return ok ? pump() : new Promise((r) => out.once('drain', r)).then(pump);
        }).catch(reject);
        pump();
      });
      if (d.size && got !== d.size) throw new Error('The download is incomplete');
      const want = /^sha256:([0-9a-f]{64})$/i.exec(d.digest || '');
      if (want && hash.digest('hex') !== want[1].toLowerCase()) throw new Error('The download is damaged (checksum differs)');
      this._set({ state: 'ready', progress: 1, file });
      return file;
    } catch (e) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      this._set({ state: 'idle', progress: 0, file: '', error: (e && e.message) || 'The download failed' });
      throw e;
    }
  }

  // Download, then replace this app with the new one and start it again. The app quits (quit()) once
  // the installer is running on its own; nothing else is touched, so the user's data stays.
  async install() {
    if (!this.canInstall) return this.open();
    if (this.status.state === 'installing') return;
    const file = await this.download();
    const inst = require('./updates-install.js');
    const plan = inst.plan({ platform: this.platform, file, pid: this.pid, execPath: this.execPath, dir: this.dir, env: process.env });
    if (plan.kind === 'manual') { // no way to install in place here: the file opens for the user
      this.openUrl(`file://${file.replace(/\\/g, '/')}`);
      this._set({ state: 'ready', error: plan.reason || '' });
      return;
    }
    this._set({ state: 'installing', error: '' });
    try {
      this.launch(plan);
    } catch (e) {
      this._set({ state: 'ready', error: (e && e.message) || 'Couldn’t start the installer' });
      throw e;
    }
    setTimeout(() => this.quit(), 300);
  }

  _set(fields) {
    Object.assign(this.status, fields);
    this.onChange();
  }

  get view() {
    return { current: this.current, auto: this.cfg.auto !== false, channel: this.channel, install: this.cfg.install === 'auto' ? 'auto' : 'ask',
      repo: this.repo, canInstall: this.canInstall, ...this.status };
  }
}

module.exports = { Updates, compare, comparePre, pickAsset, pickRelease, channelFor, parse, readSource, REPO: DEFAULT_REPO, DEFAULT_REPO };
