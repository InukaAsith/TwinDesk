// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume (shared/rezume.js) between two sides joined back to back, and the browser files it falls
// back on (shared/browsertabs.js): what's offered, when, to whom, and what opening does.
// Run with: node shared/test/rezume.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReZume, normalize, httpUrl, STABLE_MS, TTL_MS } = require('../rezume.js');
const tabs = require('../browsertabs.js');

let now = 1e12;
Date.now = () => now;

// Two sides: a's sends arrive at b and the other way round.
function pair(osA = 'win', osB = 'mac') {
  const bus = { a: new EventEmitter(), b: new EventEmitter() };
  const sent = { a: [], b: [] };
  const mk = (me, other, peerOs) => ({
    on: (t, fn) => bus[me].on(t, fn),
    send: (m) => { sent[me].push(m); bus[other].emit(m.t, JSON.parse(JSON.stringify(m))); return true; },
    peer: () => (bus.up ? { os: peerOs, name: other.toUpperCase() } : null),
    welcome: (fn) => bus[me].on('welcome', fn),
    closed: (fn) => bus[me].on('closed', fn),
  });
  return { bus, sent, link: { a: mk('a', 'b', osB), b: mk('b', 'a', osA) } };
}

function side(link, over = {}) {
  const cfg = normalize({ on: true });
  const opened = [];
  const h = new ReZume({
    link, cfg: () => cfg,
    detect: async () => h.now,
    open: { url: (u) => opened.push(['url', u]), file: (p) => opened.push(['file', p]), phoneApp: (pkg) => opened.push(['app', pkg]) },
    ...over,
  });
  h.now = null;
  h.opened = opened;
  h.c = cfg;
  return h;
}

// A look now, after the poll's own one (it may be under way).
const tick = async (h) => {
  while (h.busy) await new Promise((r) => setImmediate(r));
  await h._tick();
};

const start = (p, a, b) => {
  p.bus.up = true;
  p.bus.a.emit('welcome');
  p.bus.b.emit('welcome');
};

(async () => {
  // ---- settings and checks ----
  assert.deepStrictEqual(normalize(undefined).on, false); // off until turned on
  assert.strictEqual(normalize({ on: true, notify: 'yes' }).notify, false);
  assert.strictEqual(httpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(httpUrl('javascript:alert(1)'), '');
  assert.strictEqual(httpUrl('file:///etc/passwd'), '');
  assert.strictEqual(httpUrl('ms-settings:privacy'), '');

  // ---- a tab offered once it stayed in front, taken on the other side ----
  {
    const p = pair();
    const a = side(p.link.a);
    const b = side(p.link.b);
    start(p, a, b);
    assert.ok(p.sent.a.some((m) => m.t === 'rz.policy' && m.on === true));
    assert.ok(b.peerPolicy && b.peerPolicy.on);
    a.now = { kind: 'web', url: 'https://example.com/page', title: 'Example', app: 'chrome.exe', appName: 'Chrome' };
    await tick(a);
    assert.ok(!p.sent.a.some((m) => m.t === 'rz.offer'), 'not offered at once');
    now += STABLE_MS / 2;
    await tick(a);
    assert.ok(!p.sent.a.some((m) => m.t === 'rz.offer'), 'not offered before it stayed');
    now += STABLE_MS;
    await tick(a);
    const offer = p.sent.a.find((m) => m.t === 'rz.offer');
    assert.ok(offer && offer.url === 'https://example.com/page' && !offer.push);
    let shown = null;
    b.on('offer', (o) => { shown = o; });
    // b had it before the listener; the view has it
    assert.strictEqual(b.view.incoming.url, 'https://example.com/page');
    assert.strictEqual(b.view.incoming.title, 'Example');
    // the same again: no new offer
    now += 5000;
    await tick(a);
    assert.strictEqual(p.sent.a.filter((m) => m.t === 'rz.offer').length, 1);
    await b.take();
    assert.deepStrictEqual(b.opened, [['url', 'https://example.com/page']]);
    assert.strictEqual(b.view.incoming, null);
    assert.strictEqual(shown, null);

    // a bad address from the other side is never opened
    p.bus.b.emit('rz.offer', { id: 'x', kind: 'web', url: 'file:///C:/Windows/win.ini', title: 'x' });
    assert.strictEqual(b.view.incoming, null);

    // pushed (Send to): opened at once on b
    a.last = { ...a._clean({ kind: 'web', url: 'https://example.org/', title: 'Org' }), seenAt: now };
    await a.push();
    assert.deepStrictEqual(b.opened[1], ['url', 'https://example.org/']);

    // pushes off on b: shown instead
    b.c.push = false;
    b.apply();
    await a.push();
    assert.strictEqual(b.opened.length, 2);
    assert.strictEqual(b.view.incoming.url, 'https://example.org/');
    b.dismiss();
    assert.strictEqual(b.view.incoming, null);

    // receiving off on b: a stops offering
    b.c.receive = false;
    b.apply();
    assert.strictEqual(a.peerPolicy.on, false);
    a.now = { kind: 'web', url: 'https://other.example/', title: 'Other' };
    await tick(a); now += STABLE_MS + 1; await tick(a);
    assert.ok(!p.sent.a.some((m) => m.t === 'rz.offer' && m.url === 'https://other.example/'));
    a.shutdown(); b.shutdown();
  }

  // ---- a document: offered by name, its file sent when taken, opened when it lands ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-'));
    const file = path.join(dir, 'report.docx');
    fs.writeFileSync(file, 'hello');
    const p = pair();
    const files = [];
    const expected = [];
    const a = side(p.link.a, { sendFile: (f, batch) => { files.push([f, batch]); return true; } });
    const b = side(p.link.b, { expectFile: (batch) => expected.push(batch) });
    start(p, a, b);
    a.now = { kind: 'doc', path: file, title: 'report.docx - Word', app: 'WINWORD.EXE', appName: 'Word' };
    await tick(a); now += STABLE_MS + 1; await tick(a);
    const offer = p.sent.a.find((m) => m.t === 'rz.offer');
    assert.strictEqual(offer.kind, 'doc');
    assert.strictEqual(offer.name, 'report.docx');
    assert.strictEqual(offer.size, 5);
    assert.ok(!('path' in offer), 'the path stays here');
    await b.take();
    assert.deepStrictEqual(expected, ['rz-' + offer.id]);
    assert.deepStrictEqual(files, [[file, 'rz-' + offer.id]]);
    assert.ok(b.view.waiting);
    assert.strictEqual(b.received({ kind: 'send', ok: true, placed: ['/x'] }), false); // not ours
    assert.strictEqual(b.received({ kind: 'rezume', ok: true, placed: [path.join(dir, 'got.docx')] }), true);
    assert.deepStrictEqual(b.opened, [['file', path.join(dir, 'got.docx')]]);
    // gone on a meanwhile: the other side hears why
    p.bus.b.emit('rz.take', { id: 'nope' });
    fs.rmSync(dir, { recursive: true, force: true });
    a.shutdown(); b.shutdown();
  }

  // ---- a phone: its apps only with Mirror apps and wireless debugging ----
  {
    const p = pair('android', 'win');
    let adb = null;
    const pc = side(p.link.b, { adb: () => adb, phoneApps: () => [{ id: 'com.spotify.music', name: 'Spotify', icon: '' }] });
    p.bus.up = true;
    p.bus.b.emit('welcome');
    p.bus.b.emit('rz.policy', { on: true, web: true, docs: true, apps: true, detect: true });
    p.bus.b.emit('rz.offer', { id: '1', kind: 'app', app: 'com.spotify.music', title: '' });
    assert.strictEqual(pc.view.incoming, null, 'no mirroring without wireless debugging');
    adb = { ready: true, front: async () => 'com.spotify.music', openUrl: async () => {} };
    p.bus.b.emit('rz.offer', { id: '2', kind: 'app', app: 'com.spotify.music', title: '' });
    assert.strictEqual(pc.view.incoming.appName, 'Spotify'); // from the phone's list
    await pc.take();
    assert.deepStrictEqual(pc.opened, [['app', 'com.spotify.music']]);
    // home screens are never offered
    p.bus.b.emit('rz.offer', { id: '3', kind: 'app', app: 'com.google.android.apps.nexuslauncher' });
    assert.strictEqual(pc.view.incoming, null);
    // Mirror apps off: none
    pc.c.mirror = false;
    p.bus.b.emit('rz.offer', { id: '4', kind: 'app', app: 'com.spotify.music' });
    assert.strictEqual(pc.view.incoming, null);
    // a phone without Accessibility: asked through wireless debugging
    pc.c.mirror = true;
    p.bus.b.emit('rz.policy', { on: true, apps: true, detect: false });
    assert.ok(pc.adbTimer, 'asks the phone');
    await pc._askPhone();
    assert.strictEqual(pc.view.incoming.app, 'com.spotify.music');
    // the computer's tab sent to the phone opens there through wireless debugging
    const urls = [];
    adb.openUrl = async (u) => urls.push(u);
    pc.last = { ...pc._clean({ kind: 'web', url: 'https://example.com/x', title: 'X' }), seenAt: now };
    await pc.push();
    assert.deepStrictEqual(urls, ['https://example.com/x']);
    // the session ends: nothing kept
    p.bus.up = false;
    p.bus.b.emit('closed');
    assert.strictEqual(pc.view.incoming, null);
    assert.strictEqual(pc.adbTimer, null);
    pc.shutdown();
  }

  // ---- an offer gets old ----
  {
    const p = pair();
    const a = side(p.link.a);
    const b = side(p.link.b);
    start(p, a, b);
    a.now = { kind: 'web', url: 'https://example.com/', title: 'E' };
    await tick(a); now += STABLE_MS + 1; await tick(a);
    assert.ok(a.out);
    a.now = null;
    now += TTL_MS + 1;
    await tick(a);
    assert.strictEqual(a.out, null);
    assert.strictEqual(b.view.incoming, null, 'cleared there too');
    a.shutdown(); b.shutdown();
  }

  // ---- the other side comes back: what was last in front goes at once ----
  {
    const p = pair();
    const a = side(p.link.a);
    const b = side(p.link.b);
    start(p, a, b);
    a.now = { kind: 'web', url: 'https://example.com/again', title: 'Again' };
    await tick(a);
    a.now = null; // the tab isn't in front any more (TwinDesk's own window is)
    p.bus.up = false;
    p.bus.a.emit('closed');
    p.bus.b.emit('closed');
    const before = p.sent.a.filter((m) => m.t === 'rz.offer').length;
    start(p, a, b);
    await new Promise((r) => setImmediate(r));
    const offers = p.sent.a.filter((m) => m.t === 'rz.offer');
    assert.strictEqual(offers.length, before + 1, 'offered again at once');
    assert.strictEqual(offers[offers.length - 1].url, 'https://example.com/again');
    assert.strictEqual(b.view.incoming.url, 'https://example.com/again');
    a.shutdown(); b.shutdown();
  }

  // ---- browsertabs ----
  assert.strictEqual(tabs.family('chrome'), 'chromium');
  assert.strictEqual(tabs.family('org.mozilla.firefox'), 'firefox');
  assert.strictEqual(tabs.family('msedge'), 'chromium');
  assert.strictEqual(tabs.family('notepad'), '');
  assert.ok(tabs.titleMatches('Example Domain - Google Chrome', 'Example Domain'));
  assert.ok(tabs.titleMatches('Example Domain — Mozilla Firefox', 'Example Domain'));
  assert.ok(!tabs.titleMatches('Example Domain Two - Google Chrome', 'Example Domain'));
  assert.deepStrictEqual(tabs.splitTitle('Inbox - Personal - Microsoft\u200b Edge'), { page: 'Inbox', app: 'Microsoft Edge' });
  assert.deepStrictEqual(tabs.splitTitle('report - Word'), { page: 'report', app: 'Word' });
  // mozLz4: literals only, then a match that repeats them
  const lit = Buffer.from('abcd');
  const block = Buffer.concat([Buffer.from([0x44]), lit, Buffer.from([4, 0]), Buffer.from([0x00])]); // 4 literals, offset 4, length 4+4
  assert.strictEqual(tabs.lz4Block(block, 12).toString(), 'abcdabcdabcd'.slice(0, 12));
  // a Firefox session: the tab the window's title shows
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  const session = { selectedWindow: 1, windows: [{ selected: 2, tabs: [
    { index: 1, entries: [{ url: 'https://a.example/', title: 'A page' }] },
    { index: 2, entries: [{ url: 'https://b.example/old', title: 'Old' }, { url: 'https://b.example/', title: 'B page' }] },
  ] }] };
  const json = Buffer.from(JSON.stringify(session));
  // an all-literals block of any length: 0xF0, then the length's extra bytes
  const ext = [];
  let n = json.length - 15;
  while (n >= 255) { ext.push(255); n -= 255; }
  ext.push(n);
  const lz = Buffer.concat([Buffer.from([0xf0, ...ext]), json]);
  const head = Buffer.alloc(12);
  head.write('mozLz40\0', 0, 'latin1');
  head.writeUInt32LE(json.length, 8);
  fs.mkdirSync(path.join(dir, 'p1', 'sessionstore-backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'p1', 'sessionstore-backups', 'recovery.jsonlz4'), Buffer.concat([head, lz]));
  assert.strictEqual(tabs.firefoxTab([dir], 'A page — Mozilla Firefox').url, 'https://a.example/');
  assert.strictEqual(tabs.firefoxTab([dir], 'B page — Mozilla Firefox').url, 'https://b.example/');
  assert.strictEqual(tabs.firefoxTab([dir], '').url, 'https://b.example/'); // no title: the selected tab
  assert.strictEqual(tabs.firefoxTab([dir], 'Something else'), null);
  fs.rmSync(dir, { recursive: true, force: true });

  // A computer loads ReZume when it's turned on: the policy sent before that was lost, and comes again.
  {
    const p = pair();
    p.bus.up = true;
    const a = side(p.link.a);
    a.apply(); // b isn't listening yet
    const b = side(p.link.b);
    assert.strictEqual(b.view.peerKnows, false);
    b.apply();
    assert.strictEqual(a.view.peerOn, true);
    assert.strictEqual(b.view.peerOn, true, 'answered with its policy');
    const n = p.sent.a.length + p.sent.b.length;
    b.apply();
    a.apply();
    assert.strictEqual(p.sent.a.length + p.sent.b.length, n + 2, 'answered once, no back and forth');
  }

  console.log('rezume ok');
  process.exit(0); // the sides' 10-minute timers
})().catch((e) => { console.error(e); process.exit(1); });
