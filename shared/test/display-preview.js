// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A desktop preview is one current space on a display the catalog already allows.
// Run with: node shared/test/display-preview.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Preview = require('../display-preview.js');
const { DisplayShots } = require('../../mac/display-shots.js');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
}

function shotBody(displayId, extra) {
  return { ok: true, displayId: String(displayId), width: 480, height: 270, jpeg: jpegBytes().toString('base64'), ...extra };
}

function conn() {
  return { authed: true, released: false, ws: { readyState: 1 } };
}

function display(id, currentSpace, spaces) {
  const list = spaces || [currentSpace];
  return { id, name: 'Screen', primary: id === '1', current: list.indexOf(currentSpace), count: list.length, truncated: false, spaces: list };
}

function catalog(displays) {
  return { rev: 1, viewing: displays[0].id, viewGen: 3, capture: 7, displays };
}

function look(rows, extra) {
  return { inputHeld: false, overview: 'hidden', displays: rows, ...extra };
}

function row(id, current, spaces) {
  return { cgId: id, current, spaces: spaces || [current] };
}

function harness(opts) {
  const sent = [];
  const calls = [];
  const timers = [];
  const box = {
    clock: opts.clock == null ? 10000 : opts.clock,
    locked: Object.prototype.hasOwnProperty.call(opts, 'locked') ? opts.locked : false,
    look: opts.look,
    sample: opts.sample,
    reply: opts.reply,
  };
  let releaseWait = null;
  const shots = new DisplayShots({
    helper: {
      request(cmd, args) {
        calls.push({ cmd, args: { ...args } });
        if (opts.helper) return opts.helper(cmd, args, box);
        return Promise.resolve(box.reply);
      },
      send(cmd, args) {
        if (opts.recordSend) opts.recordSend.push({ cmd, args });
      },
    },
    readLocked: opts.readLocked || (async () => box.locked),
    freshLook: opts.freshLook || (async () => box.look),
    sample: opts.sampleFn || (() => box.sample),
    send(target, msg) { sent.push({ conn: target, msg }); },
    wait: opts.wait || (() => new Promise((resolve) => { releaseWait = resolve; })),
    schedule(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    now: () => box.clock,
  });
  const ask = opts.epoch == null ? 1 : opts.epoch;
  if (opts.watch !== false && box.sample && box.sample.conn && Preview.liveConn(box.sample.conn)) {
    shots.ask = ask;
    shots.watched = { conn: box.sample.conn, ws: box.sample.conn.ws, epoch: ask };
  }
  return { shots, sent, calls, timers, box, release() { if (releaseWait) releaseWait(); } };
}

async function until(pred) {
  for (let i = 0; i < 40 && !pred(); i++) await Promise.resolve();
  assert.ok(pred());
}

function jpegSent(sent) {
  return sent.filter((row) => row.msg && row.msg.jpeg);
}

async function testPolicy() {
  const targets = Preview.currentTargets(catalog([
    display('1', '10', ['10', '11']),
    display('2', '20', ['20', '21']),
    display('0', '30', ['30']),
  ]));
  assert.deepStrictEqual(targets.map((t) => t.displayId + ':' + t.spaceId), ['1:10', '2:20']);

  const mesh = Preview.currentTargets(catalog([display('1', '10', ['10', '11'])]));
  assert.deepStrictEqual(mesh, [{ displayId: '1', spaceId: '10' }]);
  assert.strictEqual(Preview.catalogPermits(catalog([display('1', '10')]), '2'), false);

  const stored = new Map();
  stored.set(Preview.key('1', '10'), { at: 1000 });
  const both = [{ displayId: '1', spaceId: '10' }, { displayId: '2', spaceId: '20' }];
  assert.strictEqual(Preview.choose(both, stored, 1500, false), null);
  assert.deepStrictEqual(Preview.choose(both, stored, 1500, true), { displayId: '2', spaceId: '20' });
  stored.set(Preview.key('2', '20'), { at: 2000 });
  assert.strictEqual(Preview.choose(both, stored, 1000 + Preview.REFRESH_MS - 1, true), null);
  assert.deepStrictEqual(Preview.choose(both, stored, 1000 + Preview.REFRESH_MS, true), { displayId: '1', spaceId: '10' });

  assert.strictEqual(Preview.screenUnlocked(null), false);
  assert.strictEqual(Preview.screenUnlocked(true), false);
  assert.strictEqual(Preview.screenUnlocked(false), true);
  assert.strictEqual(Preview.missionHidden(null), false);
  assert.strictEqual(Preview.missionHidden({ inputHeld: true }), false);
  assert.strictEqual(Preview.missionHidden({ inputHeld: false }), false);
  assert.strictEqual(Preview.missionHidden({ inputHeld: false, holdWhy: 'overview' }), false);
  assert.strictEqual(Preview.missionHidden({ inputHeld: false, holdWhy: 'accessibility' }), false);
  assert.strictEqual(Preview.missionHidden({ overview: 'visible' }), false);
  assert.strictEqual(Preview.missionHidden({ overview: 'unknown' }), false);
  assert.strictEqual(Preview.missionHidden({ overview: 'hidden' }), true);
  assert.strictEqual(Preview.missionHidden({ inputHeld: true, overview: 'hidden' }), true);
  const bound = conn();
  const auth = Preview.authorizeWant(bound, bound);
  assert.strictEqual(auth && auth.conn, bound);
  assert.strictEqual(auth && auth.ws, bound.ws);
  assert.strictEqual(Preview.authorizeWant(bound, conn()), null);
  const dead = conn();
  dead.ws.readyState = 3;
  assert.strictEqual(Preview.authorizeWant(dead, dead), null);
  const replaced = conn();
  replaced.ws = null;
  assert.strictEqual(Preview.authorizeWant(replaced, replaced), null);
  assert.strictEqual(Preview.askEpoch(1), 1);
  assert.strictEqual(Preview.askEpoch(Preview.ASK_MAX), Preview.ASK_MAX);
  assert.strictEqual(Preview.askEpoch(0), null);
  assert.strictEqual(Preview.askEpoch(1.5), null);
  assert.strictEqual(Preview.askEpoch(Preview.ASK_MAX + 1), null);
  assert.strictEqual(Preview.askEpoch('1'), null);
  assert.strictEqual(Preview.currentSpaceId(look([row('1', '10', ['10', '11']), row('1', '10')]), '1'), '');
  assert.strictEqual(Preview.currentSpaceId(look([row('1', '11', ['10', '11'])]), '1'), '11');

  const link = { authed: true, ws: { readyState: 1 } };
  const host = { authed: true, released: false, ws: { readyState: 1 } };
  const session = { connected: true, linkUp: true, hostUp: true, link, ctx: host };
  assert.strictEqual(Preview.outbound(session), link);
  assert.strictEqual(Preview.liveConn(link), true);
  host.released = true;
  session.linkUp = false;
  assert.strictEqual(Preview.outbound(session), host);
  assert.strictEqual(Preview.liveConn(host), false);
  session.linkUp = true;
  assert.strictEqual(Preview.outbound(session), link);

  const ok = jpegBytes();
  assert.strictEqual(Preview.acceptJpeg(ok, 480, 270), true);
  assert.strictEqual(Preview.acceptJpeg(ok, 481, 270), false);
  const big = Buffer.alloc(Preview.MAX_BYTES + 1, 1);
  big[0] = 0xff; big[1] = 0xd8; big[big.length - 2] = 0xff; big[big.length - 1] = 0xd9;
  assert.strictEqual(Preview.decodeJpeg(big.toString('base64')), null);
  assert.strictEqual(Preview.fenceReady({ conn: host, capture: 0, viewGen: 3, displayId: '1', spaceId: '10' }), false);
}

function sampleOf(target, cat) {
  return { conn: target, sharing: true, catalog: cat, capture: 7, viewGen: 3 };
}

async function testOnePermittedDisplay() {
  const target = conn();
  const cat = catalog([display('1', '10', ['10', '11']), display('2', '20', ['20'])]);
  const h = harness({
    look: look([row('1', '10', ['10', '11']), row('2', '20', ['20']), row('9', '90', ['90'])]),
    sample: sampleOf(target, cat),
    reply: shotBody('1'),
  });
  await h.shots.kick();
  const shots = h.calls.filter((call) => call.cmd === 'displayShot');
  assert.strictEqual(shots.length, 1);
  assert.strictEqual(shots[0].args.displayId, 1);
  assert.ok(!h.calls.some((call) => call.cmd === 'spacesSwitch' || call.cmd === 'spacesCommit' || call.cmd === 'desktopCapturer'));
  assert.strictEqual(jpegSent(h.sent).length, 1);
  assert.strictEqual(h.sent[0].msg.t, 'screen.preview');
  assert.strictEqual(h.sent[0].msg.displayId, '1');
  assert.strictEqual(h.sent[0].msg.spaceId, '10');
  assert.strictEqual(h.sent[0].msg.capture, 7);
  assert.strictEqual(h.sent[0].msg.epoch, 1);
  assert.strictEqual(h.sent[0].conn, target);
  assert.ok(!h.sent.some((row) => row.msg.spaceId === '11' || row.msg.displayId === '9'));
}

async function testMeshDoesNotAskForAnotherDisplay() {
  const target = conn();
  const h = harness({
    look: look([row('1', '10', ['10', '11']), row('2', '20', ['20'])]),
    sample: sampleOf(target, catalog([display('1', '10', ['10', '11'])])),
    reply: shotBody('1'),
  });
  await h.shots.kick();
  assert.deepStrictEqual(h.calls.filter((call) => call.cmd === 'displayShot').map((call) => call.args.displayId), [1]);
}

async function testRefusals() {
  const target = conn();
  const cat = catalog([display('1', '10', ['10', '11'])]);
  const base = {
    look: look([row('1', '10', ['10', '11'])]),
    sample: sampleOf(target, cat),
    reply: shotBody('1'),
  };
  for (const locked of [null, true]) {
    const h = harness({ ...base, locked });
    await h.shots.kick();
    assert.strictEqual(h.calls.length, 0, String(locked));
    assert.strictEqual(jpegSent(h.sent).length, 0);
  }
  const missing = harness({ ...base, look: null });
  await missing.shots.kick();
  assert.strictEqual(missing.calls.length, 0);
  const held = harness({ ...base, look: look([row('1', '10', ['10'])], { inputHeld: true }) });
  await held.shots.kick();
  assert.strictEqual(held.calls.filter((call) => call.cmd === 'displayShot').length, 1);
  const visible = harness({ ...base, look: look([row('1', '10', ['10'])], { holdWhy: 'overview', overview: 'visible' }) });
  await visible.shots.kick();
  assert.strictEqual(visible.calls.length, 0);
  const unread = harness({ ...base, look: look([row('1', '10', ['10'])], { holdWhy: 'accessibility', overview: 'unknown' }) });
  await unread.shots.kick();
  assert.strictEqual(unread.calls.length, 0);
  const blank = harness({ ...base, look: { inputHeld: false, displays: [row('1', '10', ['10'])] } });
  await blank.shots.kick();
  assert.strictEqual(blank.calls.length, 0);
}

async function testDiscardAfterCapture() {
  const target = conn();
  const cat = catalog([display('1', '10', ['10', '11'])]);
  let reads = 0;
  const moved = harness({
    sample: sampleOf(target, cat),
    reply: shotBody('1'),
    freshLook: async () => {
      reads += 1;
      return reads === 1 ? look([row('1', '10', ['10', '11'])]) : look([row('1', '11', ['10', '11'])]);
    },
  });
  await moved.shots.kick();
  assert.strictEqual(moved.calls.length, 1);
  assert.strictEqual(jpegSent(moved.sent).length, 0);

  const replaced = conn();
  const swapped = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(replaced, cat),
    helper: async () => {
      replaced.ws = { readyState: 1 };
      return shotBody('1');
    },
  });
  await swapped.shots.kick();
  assert.strictEqual(jpegSent(swapped.sent).length, 0);

  const changed = sampleOf(conn(), cat);
  const late = harness({
    look: look([row('1', '10', ['10'])]),
    sample: changed,
    helper: async () => {
      changed.capture = 8;
      return shotBody('1');
    },
  });
  await late.shots.kick();
  assert.strictEqual(jpegSent(late.sent).length, 0);

  const mismatch = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), cat),
    reply: shotBody('9'),
  });
  await mismatch.shots.kick();
  assert.strictEqual(jpegSent(mismatch.sent).length, 0);

  const wide = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), cat),
    reply: shotBody('1', { width: 481 }),
  });
  await wide.shots.kick();
  assert.strictEqual(jpegSent(wide.sent).length, 0);

  const huge = Buffer.alloc(Preview.MAX_BYTES + 1, 2);
  huge[0] = 0xff; huge[1] = 0xd8; huge[huge.length - 2] = 0xff; huge[huge.length - 1] = 0xd9;
  const over = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), cat),
    reply: shotBody('1', { jpeg: huge.toString('base64') }),
  });
  await over.shots.kick();
  assert.strictEqual(jpegSent(over.sent).length, 0);
}

async function testTimeoutDropsTheLateJpeg() {
  let finishHelper = null;
  let finishWait = null;
  const h = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    helper: () => new Promise((resolve) => { finishHelper = resolve; }),
    wait: () => new Promise((resolve) => { finishWait = resolve; }),
  });
  const pending = h.shots.kick();
  await until(() => finishWait && finishHelper);
  finishWait();
  await pending;
  assert.strictEqual(jpegSent(h.sent).length, 0);
  finishHelper(shotBody('1'));
  await until(() => true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(jpegSent(h.sent).length, 0);
  assert.strictEqual(h.calls.length, 1);
}

async function testGapAndClearAndOs() {
  const target = conn();
  const cat = catalog([display('1', '10', ['10']), display('2', '20', ['20'])]);
  const state = sampleOf(target, cat);
  const h = harness({
    look: look([row('1', '10', ['10']), row('2', '20', ['20'])]),
    sample: state,
    reply: shotBody('1'),
  });
  await h.shots.kick();
  assert.deepStrictEqual(h.calls.map((call) => call.args.displayId), [1]);
  h.box.clock += 100;
  await h.shots.kick();
  assert.strictEqual(h.calls.length, 1);
  h.box.clock += Preview.MIN_GAP_MS;
  h.box.reply = shotBody('2');
  await h.shots.kick();
  assert.deepStrictEqual(h.calls.map((call) => call.args.displayId), [1, 2]);

  state.sharing = false;
  h.box.clock += Preview.MIN_GAP_MS;
  await h.shots.kick();
  assert.ok(h.sent.some((row) => row.msg.clear === true && row.msg.epoch === 1));
  assert.strictEqual(h.calls.length, 2);

  const os = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    reply: { ok: true, unavailable: 'os' },
  });
  await os.shots.kick();
  assert.deepStrictEqual(os.sent.map((row) => row.msg.unavailable), ['os']);
  assert.ok(os.sent.every((row) => row.msg.epoch === 1));
  assert.ok(!os.calls.some((call) => call.cmd !== 'displayShot'));
  os.box.clock += Preview.REFRESH_MS * 2;
  await os.shots.kick();
  assert.strictEqual(os.calls.length, 1);
  assert.strictEqual(os.sent.length, 1);

  const permission = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    reply: { ok: true, unavailable: 'permission' },
  });
  await permission.shots.kick();
  assert.strictEqual(permission.sent.filter((row) => row.msg.unavailable === 'permission' && row.msg.epoch === 1).length, 1);
  permission.box.clock += 100;
  await permission.shots.kick();
  assert.strictEqual(permission.calls.length, 1);
  permission.box.clock += Preview.REFRESH_MS;
  permission.box.reply = shotBody('1');
  await permission.shots.kick();
  assert.strictEqual(permission.calls.length, 2);
  assert.strictEqual(jpegSent(permission.sent).length, 1);
}

async function testNoWatchDoesNotCapture() {
  let lockReads = 0;
  const h = harness({
    watch: false,
    readLocked: async () => { lockReads++; return false; },
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    reply: shotBody('1'),
  });
  await h.shots.kick();
  await h.shots.kick();
  assert.strictEqual(lockReads, 0, 'idle state updates do not launch lock-state helpers');
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(h.timers.length, 0);
  assert.strictEqual(jpegSent(h.sent).length, 0);
}

async function testCloseDropsInFlightWithoutClearing() {
  const sends = [];
  let finishHelper = null;
  const h = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    recordSend: sends,
    helper: () => new Promise((resolve) => { finishHelper = resolve; }),
    wait: () => new Promise(() => {}),
  });
  const pending = h.shots.kick();
  await until(() => finishHelper);
  h.shots.cancel('close');
  finishHelper(shotBody('1'));
  await pending;
  assert.strictEqual(jpegSent(h.sent).length, 0);
  assert.ok(!h.sent.some((row) => row.msg.clear === true));
  assert.ok(sends.some((row) => row.cmd === 'displayShotCancel'));
}

async function testSessionEndClearsAndALaterWatchCaptures() {
  const sends = [];
  const target = conn();
  const h = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(target, catalog([display('1', '10', ['10'])])),
    reply: shotBody('1'),
    recordSend: sends,
  });
  await h.shots.kick();
  assert.strictEqual(jpegSent(h.sent).length, 1);
  h.shots.cancel('session');
  assert.ok(h.sent.some((row) => row.msg.clear === true && row.msg.epoch === 1));
  assert.ok(sends.some((row) => row.cmd === 'displayShotCancel'));
  h.sent.length = 0;
  h.box.clock += Preview.MIN_GAP_MS;
  await h.shots.watch(target, 2);
  assert.strictEqual(jpegSent(h.sent).length, 1);
  assert.strictEqual(h.sent[0].msg.epoch, 2);
  assert.strictEqual(h.sent[0].conn, target);
}

async function testViewGenChangeDoesNotClear() {
  const state = sampleOf(conn(), catalog([display('1', '10', ['10'])]));
  const h = harness({
    look: look([row('1', '10', ['10'])]),
    sample: state,
    reply: shotBody('1'),
  });
  await h.shots.kick();
  state.viewGen = 4;
  h.box.clock += Preview.MIN_GAP_MS;
  await h.shots.kick();
  assert.ok(!h.sent.some((row) => row.msg.clear === true));
  assert.strictEqual(jpegSent(h.sent).length, 1);
}

async function testOverviewShownAfterCaptureIsDropped() {
  let reads = 0;
  const h = harness({
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    reply: shotBody('1'),
    freshLook: async () => {
      reads += 1;
      return look([row('1', '10', ['10'])], reads === 1 ? {} : { overview: 'visible' });
    },
  });
  await h.shots.kick();
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(jpegSent(h.sent).length, 0);
  assert.ok(!h.sent.some((row) => row.msg.clear === true));
}

async function testStaleReplyKeepsTheLastSeen() {
  const h = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    reply: shotBody('1'),
  });
  await h.shots.kick();
  h.box.clock += Preview.REFRESH_MS;
  h.box.reply = { ok: true, unavailable: 'stale' };
  await h.shots.kick();
  assert.ok(!h.sent.some((row) => row.msg.clear === true));
  assert.strictEqual(jpegSent(h.sent).length, 1);
}

async function testLockClearsAStoredShot() {
  const h = harness({
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    reply: shotBody('1'),
  });
  await h.shots.kick();
  h.shots.cancel('close');
  h.box.locked = true;
  h.box.clock += Preview.MIN_GAP_MS;
  await h.shots.kick();
  assert.ok(h.sent.some((row) => row.msg.clear === true && row.msg.epoch === 1));
  assert.strictEqual(jpegSent(h.sent).length, 1);
}

async function testSheetOpenEpochOnEveryReply() {
  const target = conn();
  const h = harness({
    epoch: 41,
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(target, catalog([display('1', '10', ['10'])])),
    reply: shotBody('1'),
  });
  await h.shots.kick();
  assert.strictEqual(jpegSent(h.sent)[0].msg.epoch, 41);
  h.shots.cancel('close');
  assert.ok(!h.sent.some((row) => row.msg.clear === true));
  h.box.clock += Preview.REFRESH_MS;
  await h.shots.watch(target, 42);
  const pictures = jpegSent(h.sent);
  assert.strictEqual(pictures.length, 2);
  assert.strictEqual(pictures[0].msg.epoch, 41);
  assert.strictEqual(pictures[1].msg.epoch, 42);
  await h.shots.watch(target, 41);
  assert.strictEqual(h.shots.watched.epoch, 42, 'an older open cannot replace the current subscription');
  h.shots.cancel('session');
  assert.ok(h.sent.some((row) => row.msg.clear === true && row.msg.epoch === 42));

  const refused = harness({
    watch: false,
    look: look([row('1', '10', ['10'])]),
    sample: sampleOf(conn(), catalog([display('1', '10', ['10'])])),
    reply: shotBody('1'),
  });
  await refused.shots.watch(refused.box.sample.conn, 0);
  await refused.shots.watch(refused.box.sample.conn);
  assert.strictEqual(refused.calls.length, 0);
  assert.strictEqual(refused.sent.length, 0);
}

async function testANewSocketDoesNotReceiveTheOldPicture() {
  const first = conn();
  const state = sampleOf(first, catalog([display('1', '10', ['10'])]));
  const h = harness({
    look: look([row('1', '10', ['10'])]),
    sample: state,
    reply: shotBody('1'),
  });
  await h.shots.kick();
  const second = conn();
  first.ws = { readyState: 3 };
  state.conn = second;
  h.box.clock += 100;
  await h.shots.kick();
  assert.ok(!h.sent.some((row) => row.conn === second));
}

function testSources() {
  const swift = read('mac-helper/Sources/macshare-helper/DisplayShot.swift');
  const main = read('mac-helper/Sources/macshare-helper/main.swift');
  const shotCase = main.slice(main.indexOf('case "displayShot"'), main.indexOf('case "spacesLook"'));
  const shots = read('mac/display-shots.js');
  const one = read('mac/main.js');
  const mesh = read('mac/mesh/main.js');
  const phone = read('android/app/src/main/java/com/twindesk/android/DesktopPreview.kt');
  assert.strictEqual((swift.match(/captureImage/g) || []).length, 1);
  for (const banned of ['CGDisplayCreateImage', 'CGWindowListCreateImage', 'CGRequestScreenCaptureAccess', 'desktopCapturer', 'getSources']) {
    assert.ok(!swift.includes(banned), banned);
    assert.ok(!shotCase.includes(banned), banned);
  }
  assert.ok(swift.includes('CGPreflightScreenCaptureAccess'));
  assert.ok(swift.includes('showsCursor = false'));
  assert.ok(swift.includes('#available(macOS 14.0, *)'));
  assert.ok(main.includes('case "displayShot"'));
  assert.ok(main.includes('case "displayShotCancel"'));
  assert.ok(main.includes('ShotEpoch.begin()'));
  assert.ok(main.includes('looked["overview"]'));
  assert.ok(swift.includes('enum ShotEpoch'));
  assert.ok(swift.includes('["unavailable": "stale"]'));
  assert.strictEqual((swift.match(/captureImage/g) || []).length, 1);
  const listed = swift.indexOf('SCShareableContent.excludingDesktopWindows');
  const captureAt = swift.indexOf('SCScreenshotManager.captureImage');
  const captureLine = swift.lastIndexOf('\n', captureAt);
  const prevBreak = swift.lastIndexOf('\n', captureLine - 1);
  const lineBeforeCapture = swift.slice(prevBreak + 1, captureLine);
  const ownsAfterList = swift.indexOf('ShotEpoch.owns(token)', listed);
  assert.ok(listed !== -1 && listed < captureAt, 'shareable content is read before the screenshot');
  assert.ok(ownsAfterList !== -1 && ownsAfterList < captureAt, 'a cancel during enumeration is visible before captureImage');
  assert.ok(lineBeforeCapture.includes('if !ShotEpoch.owns(token)'), 'owns is checked immediately before captureImage');
  assert.ok(read('mac-helper/Sources/macshare-helper/SpacesAX.swift').includes('enum OverviewReport'));
  assert.ok(read('mac-helper/Sources/macshare-helper/SpacesAX.swift').includes('case .show(.hidden)'));
  assert.ok(!shots.includes('desktopCapturer'));
  assert.ok(!shots.includes('spacesSwitch'));
  assert.ok(!shots.includes('getSources'));
  assert.ok(one.includes('display-shots.js'));
  assert.ok(mesh.includes('display-shots.js'));
  assert.ok(one.includes('Preview.liveConn'));
  assert.ok(mesh.includes('Preview.outbound'));
  assert.ok(mesh.includes('offerDisplays: false'));
  assert.ok(phone.includes('const val MAX_EDGE = 480'));
  assert.ok(phone.includes('const val MAX_BYTES = 24 * 1024'));
  assert.ok(phone.includes('const val MAX_SHOTS = 12'));
  assert.ok(phone.includes('val stale: Boolean'));
  assert.ok(!phone.includes('BitmapFactory'));
  assert.ok(read('shared/protocol.js').includes("SCREEN_PREVIEW: 'screen.preview'"));
  assert.ok(read('shared/protocol.js').includes("SCREEN_PREVIEW_WANT: 'screen.preview.want'"));
  assert.ok(one.includes('SCREEN_PREVIEW_WANT'));
  assert.ok(mesh.includes('SCREEN_PREVIEW_WANT'));
  assert.ok(one.includes('Preview.askEpoch(m.epoch)'));
  assert.ok(mesh.includes('Preview.askEpoch(m.epoch)'));
  assert.ok(one.includes('previewShots.watch(auth.conn, ask)'));
  assert.ok(mesh.includes('previewShots.watch(auth.conn, ask)'));
  assert.ok(shots.includes('epoch: ask'));
  const web = read('android/app/src/main/java/com/twindesk/android/Web.kt');
  const sheet = web.slice(web.indexOf('fun previewSheet'), web.indexOf('private fun endPreviewSession'));
  assert.ok(sheet.includes('ask.open()'));
  assert.ok(sheet.includes('ask.close()'));
  assert.ok(sheet.includes('"epoch" to epoch'));
  assert.ok(!sheet.includes('ask.end()'));
  const ended = web.slice(web.indexOf('private fun endPreviewSession'), web.indexOf('override fun onWelcome'));
  assert.ok(ended.includes('ask.end()'));
  assert.ok(ended.includes('"epoch" to epoch'));
  assert.ok(web.includes('ask.accepts('));
  const protocol = read('shared/protocol.js');
  const wantLine = protocol.slice(protocol.indexOf('SCREEN_PREVIEW_WANT:'), protocol.indexOf('SCREEN_PREVIEW:'));
  const previewLine = protocol.slice(protocol.indexOf('SCREEN_PREVIEW:'), protocol.indexOf('PAIR_SYNC:'));
  assert.ok(wantLine.includes('{on, epoch}'));
  assert.ok(previewLine.includes('{epoch, displayId, spaceId, capture, viewGen, width, height, jpeg}'));
  assert.ok(previewLine.includes('{clear:true}'));
  assert.ok(previewLine.includes("{unavailable:'os'|'permission'}"));
  assert.ok(one.includes("powerMonitor.on('lock-screen'"));
  assert.ok(mesh.includes("powerMonitor.on('lock-screen'"));
}

async function main() {
  await testPolicy();
  await testOnePermittedDisplay();
  await testMeshDoesNotAskForAnotherDisplay();
  await testRefusals();
  await testDiscardAfterCapture();
  await testTimeoutDropsTheLateJpeg();
  await testGapAndClearAndOs();
  await testNoWatchDoesNotCapture();
  await testCloseDropsInFlightWithoutClearing();
  await testSessionEndClearsAndALaterWatchCaptures();
  await testViewGenChangeDoesNotClear();
  await testOverviewShownAfterCaptureIsDropped();
  await testStaleReplyKeepsTheLastSeen();
  await testLockClearsAStoredShot();
  await testSheetOpenEpochOnEveryReply();
  await testANewSocketDoesNotReceiveTheOldPicture();
  testSources();
  console.log('display-preview: one permitted display, session memory, and no second capture API.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
