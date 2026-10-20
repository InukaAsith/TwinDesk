'use strict';

// Updates: versions, channels, which repository a build follows, the real download (a local HTTP
// server stands in for GitHub) and the installer plans for every platform.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const U = require('../updates');
const I = require('../updates-install');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-upd-'));

// ---- versions: pre-releases of one line are numbered, a full release beats its pre-releases ----
assert.ok(U.compare('2.1.10-pr1', '2.1.9') > 0);
assert.ok(U.compare('2.1.10-pr2', '2.1.10-pr10') < 0, 'pr2 is older than pr10');
assert.ok(U.compare('2.1.10', '2.1.10-pr10') > 0);
assert.ok(U.compare('2.2.0', '2.1.99-pr5') > 0);
assert.ok(U.compare('v2.1.1', '2.1.1') === 0);
assert.ok(U.compare('1.2.3-beta.1', '1.2.3-beta.2') < 0);
assert.strictEqual(U.channelFor(undefined, '2.1.10-pr1'), 'beta', 'a pre-release build starts on beta');
assert.strictEqual(U.channelFor(undefined, '2.1.10'), 'stable');
assert.strictEqual(U.channelFor('stable', '2.1.10-pr1'), 'stable', 'the setting wins');
assert.strictEqual(U.channelFor('nonsense', '2.1.10'), 'stable');

// ---- which release ----
const rel = (tag, extra = {}) => ({ tag_name: tag, name: tag, html_url: 'https://x/' + tag, assets: [], ...extra });
const list = [rel('v2.1.2', {}), rel('v2.2.0-pr3', { prerelease: true }), rel('v2.3.0', { draft: true }), rel('v2.2.0-pr10', { prerelease: true }), rel('v2.1.9')];
assert.strictEqual(U.pickRelease(list, 'stable').version, '2.1.9', 'stable: no drafts, no pre-releases');
assert.strictEqual(U.pickRelease(list, 'beta').version, '2.2.0-pr10', 'beta: the highest, pre-releases included');
assert.strictEqual(U.pickRelease([rel('v2.2.0'), rel('v2.2.0-pr4', { prerelease: true })], 'beta').version, '2.2.0', 'beta never goes below the stable one');
assert.strictEqual(U.pickRelease([], 'beta'), null);

// ---- the repository a build follows ----
{
  const f = path.join(tmp, 'src.json');
  fs.writeFileSync(f, JSON.stringify({ repo: 'erdodo/TwinDesk' }));
  assert.strictEqual(U.readSource(f), 'erdodo/TwinDesk', 'a build from a fork follows the fork');
  fs.writeFileSync(f, JSON.stringify({ repo: 'InukaAsith/TwinDesk' }));
  assert.strictEqual(U.readSource(f), 'InukaAsith/TwinDesk', 'a build from the main project follows it');
  fs.writeFileSync(f, JSON.stringify({ repo: 'evil/../../x?y' }));
  assert.strictEqual(U.readSource(f), U.DEFAULT_REPO, 'a bad value is ignored');
  assert.strictEqual(U.readSource(path.join(tmp, 'missing.json')), U.DEFAULT_REPO, 'a checkout follows the default');
}

// ---- assets keep the digest ----
{
  const a = U.pickAsset([{ name: 'TwinDesk-Setup-2.2.0.exe', browser_download_url: 'u', size: 3, digest: 'sha256:' + 'a'.repeat(64) }], 'win', 'x64');
  assert.strictEqual(a.digest, 'sha256:' + 'a'.repeat(64));
}

// ---- installer plans ----
{
  const win = I.plan({ platform: 'win', file: "C:\\t\\Setup's.exe", pid: 4242, execPath: 'C:\\Program Files\\TwinDesk\\TwinDesk.exe', dir: tmp });
  assert.strictEqual(win.kind, 'win');
  assert.ok(win.script.includes("Setup''s.exe"), 'quotes in a path are escaped');
  assert.ok(win.script.includes('-Verb RunAs') && win.script.includes("'/S'"), 'silent, with the elevation prompt');
  assert.ok(win.script.includes('Wait-Process -Id 4242'), 'waits for the app');
  assert.ok(/Start-Process -FilePath '.*TwinDesk\.exe'/.test(win.script), 'starts the app again');
  assert.ok(!/userData|Roaming|MacShare/i.test(win.script), 'never touches the data folder');

  const dir = fs.mkdtempSync(path.join(tmp, 'Apps-'));
  const app = path.join(dir, 'TwinDesk.app').replace(/\\/g, '/');
  const mac = I.plan({ platform: 'mac', file: '/tmp/u/TwinDesk-2.2.0.dmg', pid: 7, execPath: app + '/Contents/MacOS/TwinDesk', dir: tmp });
  assert.strictEqual(mac.kind, 'mac');
  assert.ok(mac.script.includes('ditto') && mac.script.includes('hdiutil attach') && mac.script.includes('open "$APP"'));
  assert.ok(mac.script.includes('xattr -dr com.apple.quarantine'));
  assert.ok(!/rm -rf "\$APP"/.test(mac.script), 'the old app is moved aside, never deleted before the new one is in place');
  assert.strictEqual(I.plan({ platform: 'mac', file: '/tmp/x.dmg', pid: 1, execPath: '/usr/bin/electron', dir: tmp }).kind, 'manual', 'not an installed app');
  assert.strictEqual(I.macAppPath('/Applications/TwinDesk.app/Contents/MacOS/TwinDesk'), '/Applications/TwinDesk.app');

  const img = path.join(dir, 'TwinDesk.AppImage');
  const li = I.plan({ platform: 'linux', file: '/tmp/u/TwinDesk-2.2.0.AppImage', pid: 9, execPath: '/tmp/.mount_x/twindesk', dir: tmp, env: { APPIMAGE: img } });
  assert.strictEqual(li.kind, 'appimage');
  assert.ok(li.script.includes('mv -f'));
  assert.strictEqual(I.plan({ platform: 'linux', file: '/tmp/u/x.AppImage', pid: 9, execPath: '/x', dir: tmp, env: {} }).kind, 'manual');
  assert.strictEqual(I.plan({ platform: 'linux', file: '/tmp/u/x.deb', pid: 9, execPath: '/usr/bin/twindesk', dir: tmp }).kind, 'deb');
}

// ---- the whole thing against a local "GitHub" ----
async function main() {
  const payload = crypto.randomBytes(300 * 1024);
  const good = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
  let digest = good;
  let base = '';
  const releases = () => [
    { tag_name: 'v2.2.0-pr2', name: 'TwinDesk 2.2.0-pr2', draft: false, prerelease: true, html_url: base + '/r/2.2.0-pr2',
      assets: [{ name: 'TwinDesk-Setup-2.2.0-pr2.exe', size: payload.length, digest, browser_download_url: base + '/dl/setup.exe' }] },
    { tag_name: 'v2.1.5', name: 'TwinDesk 2.1.5', draft: false, prerelease: false, html_url: base + '/r/2.1.5',
      assets: [{ name: 'TwinDesk-Setup-2.1.5.exe', size: payload.length, digest, browser_download_url: base + '/dl/setup.exe' }] },
  ];
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/repos/erdodo/TwinDesk/releases/latest')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(releases()[1]));
    }
    if (req.url.startsWith('/repos/erdodo/TwinDesk/releases')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(releases()));
    }
    if (req.url === '/dl/setup.exe') {
      res.setHeader('content-length', payload.length);
      return res.end(payload);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const viaLocal = (url, opts) => fetch(url.replace('https://api.github.com', base), opts);

  const make = (settings, over = {}) => {
    const launched = [];
    let quit = 0;
    const u = new U.Updates({
      current: '2.1.4', platform: 'win', arch: 'x64', repo: 'erdodo/TwinDesk', getSettings: () => settings, fetch: viaLocal,
      dir: path.join(tmp, 'dl-' + Math.random().toString(16).slice(2)), execPath: 'C:\\TwinDesk\\TwinDesk.exe', pid: 11,
      launch: (p) => launched.push(p), quit: () => { quit++; }, openUrl: () => {}, ...over,
    });
    return { u, launched, quits: () => quit };
  };

  // stable: the latest full release of that repository, never the pre-release
  {
    const s = { updates: { auto: true, notified: '' } };
    const { u } = make(s);
    await u.check(true);
    assert.strictEqual(u.status.latest, '2.1.5');
    assert.strictEqual(u.status.prerelease, false);
    assert.ok(seen.some((x) => x.startsWith('/repos/erdodo/TwinDesk/releases/latest')), 'asks the repository it came from');
  }
  // beta: the pre-release, offered and installable
  {
    const s = { updates: { auto: true, notified: '', channel: 'beta' } };
    const { u, launched, quits } = make(s);
    const notes = [];
    u.notify = (t) => notes.push(t);
    await u.check(false);
    assert.strictEqual(u.status.latest, '2.2.0-pr2');
    assert.strictEqual(u.status.prerelease, true);
    assert.ok(u.status.available);
    assert.ok(notes[0].includes('(beta)'), 'a beta is announced as one');
    await u.install();
    assert.strictEqual(u.status.state, 'installing');
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].kind, 'win');
    assert.ok(fs.readFileSync(u.status.file).equals(payload), 'the whole file was downloaded intact');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(quits(), 1, 'the app quits once the installer runs on its own');
  }
  // a damaged download is refused and nothing is launched
  {
    digest = 'sha256:' + '0'.repeat(64);
    const s = { updates: { auto: true, notified: '', channel: 'beta' } };
    const { u, launched } = make(s);
    await u.check(false);
    await assert.rejects(() => u.install(), /damaged/);
    assert.strictEqual(launched.length, 0);
    assert.strictEqual(u.status.state, 'idle');
    assert.ok(u.status.error);
    digest = good;
  }
  // automatic installation waits for an idle moment
  {
    const s = { updates: { auto: true, notified: '', channel: 'beta', install: 'auto' } };
    let idle = false;
    const { u, launched } = make(s, { idle: () => idle });
    await u.check(false);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(launched.length, 0, 'busy (input is shared): not now');
    idle = true;
    await u.check(false);
    await waitFor(() => launched.length === 1);
  }
  // not an installed app (a checkout): never replaces anything, opens the page instead
  {
    const opened = [];
    const s = { updates: { auto: true, notified: '', channel: 'beta' } };
    const { u, launched } = make(s, { canInstall: false, openUrl: (x) => opened.push(x) });
    await u.check(false);
    await u.install();
    assert.strictEqual(launched.length, 0);
    assert.strictEqual(opened.length, 1);
  }
  // a repository with no releases
  {
    const s = { updates: { auto: true, notified: '' } };
    const { u } = make(s, { repo: 'nobody/none' });
    await u.check(true);
    assert.strictEqual(u.status.noReleases, true);
    assert.strictEqual(u.status.available, false);
  }
  server.close();
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('updates: passed');
}, (e) => {
  console.error(e);
  process.exit(1);
});
