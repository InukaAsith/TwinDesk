// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Updates TwinDesk where it is installed, without a reinstall (shared/updates.js finds the release
// and its file; this downloads and installs that file):
//
//   mac       the DMG is mounted read-only, its TwinDesk.app copied next to this one and checked:
//             a valid signature, the same bundle id, the release's version, and above all the same
//             designated requirement as this app (the "TwinDesk Self-Signed" certificate). macOS
//             keeps Screen Recording, Accessibility and the other permissions by that requirement
//             and the app's path, so the new app is swapped in at the same path once this one has
//             quit, and nothing is asked again. A different signer (an ad-hoc repair, a self-built
//             app) is refused: the DMG is opened instead, as before.
//   win       the release's NSIS installer runs silently (/S --updated --force-run): one UAC prompt,
//             as the installer is per-machine; it closes TwinDesk, replaces the app folder and
//             starts the new version. Declined: this TwinDesk keeps running.
//   appimage  the new AppImage replaces the file this one runs from ($APPIMAGE), then a restart.
//   deb       apt-get (dpkg without it) installs the .deb through pkexec (the system's password
//             prompt), then a restart. Other Linux installs (AUR, Nix, a folder): not here.
//
// Each download is checked against the SHA-256 GitHub gives for the file (asset.digest), else its size.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || ''), err: String(stderr || ''), error: err });
  });
});
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };

class SelfUpdate {
  // dir: where downloads go (userData/updates). app: Electron's app (quit, relaunch, isPackaged).
  constructor({ platform, dir, app, fetch, log }) {
    this.platform = platform;
    this.dir = dir;
    this.app = app;
    this.fetch = fetch;
    this.log = log || ((...a) => console.log('[update]', ...a));
    this.kind = this._kind();
  }

  // How this copy can be updated in place: 'mac' | 'win' | 'appimage' | 'deb' | '' (it can't).
  _kind() {
    const app = this.app;
    if (!app || !app.isPackaged) return '';
    if (this.platform === 'mac') {
      const bundle = this.bundle();
      return bundle && writable(path.dirname(bundle)) && writable(bundle) ? 'mac' : '';
    }
    if (this.platform === 'win') return 'win';
    if (this.platform === 'linux') {
      const img = process.env.APPIMAGE;
      if (img && exists(img)) return writable(path.dirname(img)) ? 'appimage' : '';
      if (!exists('/usr/bin/pkexec') || !exists('/usr/bin/dpkg-query')) return '';
      return 'deb?'; // confirmed by dpkg-query in check()
    }
    return '';
  }

  // The .app this runs from (…/TwinDesk.app/Contents/MacOS/TwinDesk).
  bundle() {
    const b = path.resolve(process.execPath, '..', '..', '..');
    return /\.app$/i.test(b) ? b : '';
  }

  // The Linux .deb case needs the package database: this executable must belong to a package.
  async check() {
    if (this.kind !== 'deb?') return this.kind;
    const r = await run('/usr/bin/dpkg-query', ['-S', process.execPath], { timeout: 5000 });
    this.kind = r.code === 0 ? 'deb' : '';
    return this.kind;
  }

  // The release's file for this kind ('' when the file there isn't the one this kind installs).
  fits(download) {
    if (!download || !download.name) return false;
    const n = download.name;
    return {
      mac: /\.dmg$/i, win: /\.exe$/i, appimage: /\.AppImage$/i, deb: /\.deb$/i,
    }[this.kind]?.test(n) || false;
  }

  // Downloads the file (kept when it's already there and checks out). onProgress(fraction).
  async download(d, onProgress) {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = path.basename(d.name).replace(/[^\w.@+-]/g, '_');
    const file = path.join(this.dir, name);
    if (exists(file) && (await this._ok(file, d))) return file;
    // Older downloads go: one update's file at a time.
    for (const f of fs.readdirSync(this.dir)) { try { fs.rmSync(path.join(this.dir, f), { recursive: true, force: true }); } catch {} }
    const part = `${file}.part`;
    const res = await this.fetch(d.url, { headers: { 'User-Agent': 'TwinDesk' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || d.size || 0;
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let got = 0;
    let said = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        if (total && onProgress && got - said > total / 200) { said = got; onProgress(Math.min(1, got / total)); }
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      out.destroy();
      try { fs.rmSync(part, { force: true }); } catch {}
      throw e;
    }
    const want = digestOf(d);
    if ((want && hash.digest('hex') !== want) || (!want && d.size && got !== d.size)) {
      fs.rmSync(part, { force: true });
      throw new Error('The download didn’t match the release’s file');
    }
    fs.renameSync(part, file);
    if (onProgress) onProgress(1);
    return file;
  }

  async _ok(file, d) {
    const want = digestOf(d);
    if (!want) return d.size ? fs.statSync(file).size === d.size : false;
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject));
    return h.digest('hex') === want;
  }

  // Installs the downloaded file. Resolves once the swap is under way (the app quits or is closed
  // by the installer); throws with a message to show when it can't be done.
  async install(file, version) {
    if (this.kind === 'mac') return this._mac(file, version);
    if (this.kind === 'win') return this._win(file);
    if (this.kind === 'appimage') return this._appimage(file);
    if (this.kind === 'deb') return this._deb(file);
    throw new Error('This copy of TwinDesk can’t update itself');
  }

  // ---- macOS ----

  async _mac(dmg, version) {
    const app = this.bundle();
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-update-'));
    const staged = path.join(path.dirname(app), `.TwinDesk-update-${process.pid}.app`);
    fs.rmSync(staged, { recursive: true, force: true });
    const a = await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
    if (a.code !== 0) throw new Error('The disk image didn’t open');
    try {
      const inside = fs.readdirSync(mount).find((n) => /\.app$/i.test(n));
      if (!inside) throw new Error('The disk image has no app in it');
      const c = await run('/usr/bin/ditto', [path.join(mount, inside), staged]);
      if (c.code !== 0) throw new Error('Copying the new version didn’t work');
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mount, '-force']);
      try { fs.rmdirSync(mount); } catch {}
    }
    try {
      await this._macCheck(app, staged, version);
    } catch (e) {
      fs.rmSync(staged, { recursive: true, force: true });
      throw e;
    }
    // Copied by us, never quarantined; cleared anyway in case the disk image carried it.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]);
    // After this app has quit: the old bundle aside, the new one in its place (a rename on the same
    // volume), the old one gone, then the new one opened. Back as it was if the rename fails.
    const script = [
      'pid="$1"; app="$2"; new="$3"; old="$app.old-$$"',
      'i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done',
      'if mv "$app" "$old"; then',
      '  if mv "$new" "$app"; then rm -rf "$old"; else mv "$old" "$app"; fi',
      'fi',
      'rm -rf "$new"',
      'open "$app"',
    ].join('\n');
    const p = spawn('/bin/sh', ['-c', script, 'twindesk-update', String(process.pid), app, staged], { detached: true, stdio: 'ignore' });
    p.unref();
    this.log(`swapping in ${version} at ${app} after quitting`);
    setTimeout(() => this.app.quit(), 300);
  }

  // The new app must be signed by the same certificate as this one (its designated requirement),
  // so macOS treats it as the same app and keeps its permissions.
  async _macCheck(app, staged, version) {
    const v = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
    if (v.code !== 0) throw new Error('The new version’s signature isn’t valid');
    const d = await run('/usr/bin/codesign', ['-d', '-r-', app]);
    const m = /designated => (.+)/.exec(d.out + d.err);
    const req = m ? m[1].trim() : '';
    // Ad-hoc (cdhash) requirements change with every build: permissions would be asked again.
    if (!req || /\bcdhash\b/.test(req)) throw new Error('This TwinDesk is signed ad hoc: macOS would ask for its permissions again, so update it from the disk image');
    const same = await run('/usr/bin/codesign', ['--verify', '--test-requirement', `=${req}`, staged]);
    if (same.code !== 0) throw new Error('The new version is signed differently: macOS would ask for its permissions again, so update it from the disk image');
    const plist = path.join(staged, 'Contents', 'Info.plist');
    const id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).out.trim();
    const mine = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Contents', 'Info.plist')])).out.trim();
    if (!id || id !== mine) throw new Error('The disk image holds another app');
    const ver = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).out.trim();
    if (version && ver && ver !== version) throw new Error(`The disk image holds version ${ver}, not ${version}`);
  }

  // ---- Windows ----

  _win(setup) {
    const args = ['/S', '--updated', '--force-run'];
    // electron-builder's elevate.exe (in resources with a per-machine installer) asks UAC and
    // passes the arguments on; without it, cmd's start does (ShellExecute asks UAC).
    const elevate = path.join(process.resourcesPath || '', 'elevate.exe');
    const p = exists(elevate)
      ? spawn(elevate, [setup, ...args], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '""', `"${setup}"`, ...args], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    p.on('error', (e) => this.log('installer did not start', e && e.message));
    p.unref();
    this.log(`running ${path.basename(setup)} silently`);
    // The installer closes TwinDesk itself (installer.nsh: customCheckAppRunning) and starts the
    // new one; a declined UAC prompt leaves this one running.
  }

  // ---- Linux ----

  async _appimage(file) {
    const target = process.env.APPIMAGE;
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.update`);
    fs.copyFileSync(file, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target); // the running image keeps its own inode
    this.log(`replaced ${target}`);
    this.app.relaunch({ execPath: target, args: [] });
    setTimeout(() => this.app.quit(), 300);
  }

  async _deb(file) {
    fs.chmodSync(file, 0o644);
    const apt = exists('/usr/bin/apt-get');
    const r = await run('/usr/bin/pkexec', apt ? ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', file] : ['/usr/bin/dpkg', '-i', file], { timeout: 15 * 60 * 1000 });
    if (r.code === 126 || r.code === 127) throw new Error('The password prompt was closed');
    if (r.code !== 0) throw new Error(`The package didn’t install: ${(r.err || r.out).trim().split('\n').pop() || r.code}`);
    this.log('installed the .deb');
    this.app.relaunch();
    setTimeout(() => this.app.quit(), 300);
  }
}

// "sha256:…" from GitHub's asset.digest, as lowercase hex ('' when there's none).
function digestOf(d) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String((d && d.digest) || ''));
  return m ? m[1].toLowerCase() : '';
}

module.exports = { SelfUpdate, digestOf };
