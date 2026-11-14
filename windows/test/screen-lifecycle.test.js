'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const P = require('../../shared/protocol');
const ipcMain = new EventEmitter();
const powerMonitor = new EventEmitter(); // unlock-screen / resume (#81)
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
let sources;
class BrowserWindow extends EventEmitter {
  constructor() { super(); this.webContents = Object.assign(new EventEmitter(), { send() {} }); this.visible = false; }
  loadFile() { return Promise.resolve(); }
  destroy() { this.destroyed = true; this.emit('closed'); }
  isDestroyed() { return !!this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  show() { this.visible = true; this.emit('show'); }
  focus() {}
  setTitle() {}
}
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getLocale: () => 'en' }, powerMonitor, ipcMain, BrowserWindow, desktopCapturer: { getSources: () => sources() }, screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display, dipToScreenRect: (_, r) => r }) };
  return load.call(this, id, ...args);
};
const PcScreen = require('../pcscreen');
const MeshPcScreen = require('../mesh/pcscreen');
const Screen = require('../screen');
const Sender = require('../sender');
Module._load = load;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  ipcMain.removeAllListeners();
  powerMonitor.removeAllListeners();
  const sent = [], starts = [], stops = [];
  const link = Object.assign(new EventEmitter(), { status: { state: 'connected' }, current: { transport: 'ip' }, send: m => { sent.push(m); return true; }, snapshot: () => ({ link: {} }) });
  const sender = Object.assign(new EventEmitter(), { start: o => { starts.push(o); return starts.length; }, stop: s => stops.push(s) });
  const vdd = { state: { installed: true }, addMode() {}, setOn: async () => ({ name: 'virtual' }), setMode: async () => {}, find: async () => null };
  const settings = { pcScreen: { mbps: 20, input: true, extendSize: 'mac' }, keys: {}, windows: {}, monitor: {} };
  sources = async () => [{ id: 'screen:1', display_id: '1' }];
  const opts = { link, sender, settings, vdd, helper: { send() {} }, inputAllowed: () => true, onChange() {}, saveSettings() {}, isQuitting: () => false, clip: {} };
  return { link, sender, settings, vdd, opts, sent, starts, stops };
}
test('turning sharing off during source enumeration never starts capture', async () => {
  const f = fixture(), wait = deferred();
  sources = () => wait.promise;
  const pc = new PcScreen(f.opts);
  pc.mode = 'mirror'; pc.mac.accept = true;
  const applying = pc.apply(); await tick();
  await pc.setMode('off');
  wait.resolve([{ id: 'screen:1', display_id: '1' }]); await applying;
  assert.equal(f.starts.length, 0);
});
test('a permitted mirror starts capture and Off stops it immediately', async () => {
  const f = fixture(), pc = new PcScreen(f.opts); pc.mac.accept = true;
  await pc.setMode('mirror'); await tick();
  assert.equal(f.starts.length, 1); assert.equal(pc.sending.session, 1);
  await pc.setMode('off');
  assert.equal(pc.sending, null); assert.deepEqual(f.stops, [1]);
});
test('Extend setup failures settle and restore Off without leaving busy set', async () => {
  const f = fixture(), pc = new PcScreen(f.opts);
  f.vdd.setOn = async on => { if (on) throw new Error('driver unavailable'); return true; };
  await assert.doesNotReject(pc.setMode('extend'));
  assert.equal(pc.mode, 'off'); assert.equal(pc.busy, false); assert.match(pc.status.error, /driver unavailable/);
});
test('disconnect during source enumeration never starts capture', async () => {
  const f = fixture(), wait = deferred(); sources = () => wait.promise;
  const pc = new PcScreen(f.opts); pc.mode = 'mirror'; pc.mac.accept = true;
  const applying = pc.apply(); await tick();
  f.link.status.state = 'idle'; f.link.emit('closed');
  wait.resolve([{ id: 'screen:1', display_id: '1' }]); await applying;
  assert.equal(f.starts.length, 0);
});
test('Off cancels pending Extend setup and switches its display back off', async () => {
  const f = fixture(), wait = deferred(), calls = [];
  f.vdd.setOn = on => { calls.push(on); return on ? wait.promise : Promise.resolve(true); };
  const pc = new PcScreen(f.opts);
  const setting = pc.setMode('extend'); await tick();
  await pc.setMode('off'); assert.equal(pc.mode, 'off');
  wait.resolve({ name: 'virtual' }); await setting;
  assert.equal(calls.at(-1), false); assert.equal(pc.busy, false);
});
test('capture enumeration failures become a visible failure, without rejecting apply', async () => {
  const f = fixture(); sources = async () => { throw new Error('capture unavailable'); };
  const pc = new PcScreen(f.opts); pc.mode = 'mirror'; pc.mac.accept = true;
  await assert.doesNotReject(pc.apply());
  assert.equal(pc.status.status, 'failed'); assert.match(pc.status.error, /capture unavailable/);
});
test('sender failure remains visible after stopping capture', () => {
  const f = fixture(), pc = new PcScreen(f.opts);
  pc.sending = { session: 1 };
  f.sender.emit('state', 1, { status: 'failed', error: 'encoder stopped' });
  assert.equal(pc.sending, null); assert.equal(pc.status.status, 'failed');
});
test('a capture that ended by itself (the desktop locked) starts again a moment later (#81)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), pc = new PcScreen(f.opts); pc.mac.accept = true;
  await pc.setMode('mirror'); await tick();
  assert.equal(f.starts.length, 1);
  f.sender.emit('state', 1, { status: 'ended', error: 'The captured monitor went away' });
  assert.equal(pc.sending, null);
  t.mock.timers.tick(1999); await tick();
  assert.equal(f.starts.length, 1, 'not at once: the desktop is still locked');
  t.mock.timers.tick(1); await tick(); await tick();
  assert.equal(f.starts.length, 2, 'tried again');
  f.sender.emit('state', 2, { status: 'live' });
  assert.equal(pc.retries, 0, 'live: the next end waits 2 s again');
});
test('unlocking the screen starts the picture again at once, and not when sharing is off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), pc = new PcScreen(f.opts); pc.mac.accept = true;
  await pc.setMode('mirror'); await tick();
  f.sender.emit('state', 1, { status: 'ended' });
  powerMonitor.emit('unlock-screen'); await tick(); await tick();
  assert.equal(f.starts.length, 2, 'unlocked: again now');
  await pc.setMode('off');
  powerMonitor.emit('resume'); await tick();
  t.mock.timers.tick(30000); await tick();
  assert.equal(f.starts.length, 2, 'off: nothing starts');
});
test('partial viewer dimensions use a valid Extend fallback', () => {
  const f = fixture(), pc = new PcScreen(f.opts);
  pc.mac.width = 1920; pc.mac.height = 0;
  assert.deepEqual(pc._extendSize(), [1920, 1080]);
});
test('Off cancels a share request that is still waiting for Wi-Fi', async () => {
  const f = fixture(), wait = deferred(), pc = new PcScreen(f.opts);
  const starting = pc.setMode('mirror', () => wait.promise);
  assert.equal(pc.mode, 'off');
  await pc.setMode('off'); wait.resolve(true); await starting;
  assert.equal(pc.mode, 'off');
});
test('a failed Wi-Fi preparation does not enable sharing', async () => {
  const f = fixture(), pc = new PcScreen(f.opts);
  await pc.setMode('mirror', async () => false);
  assert.equal(pc.mode, 'off');
});
test('a delayed remote state cannot start sharing after the viewer stops watching', () => {
  const f = fixture(), screen = new Screen(f.opts);
  screen.wantStart = true;
  screen._onState({ on: false, remote: true });
  assert.equal(f.sent.some(m => m.t === P.T.SCREEN_CTL && m.share), false);
});
test('a remote state arriving before the viewer is shown starts sharing once it appears', () => {
  const f = fixture(), screen = new Screen(f.opts);
  screen.open(); screen._onState({ on: false, remote: true });
  assert.equal(f.sent.some(m => m.t === P.T.SCREEN_CTL && m.share), false);
  screen.win.show();
  assert.equal(f.sent.some(m => m.t === P.T.SCREEN_CTL && m.share), true);
});
test('receive input disabling releases the keys and buttons forwarded to the peer', () => {
  const f = fixture(); let allowed = true; f.opts.inputAllowed = () => allowed;
  const screen = new Screen(f.opts); screen.open(); screen.ready = true;
  screen.state.state = 'on';
  const e = { sender: screen.win.webContents };
  ipcMain.emit('rtc', e, { t: P.T.IN_KEY_DOWN, code: 'ControlLeft' });
  ipcMain.emit('rtc', e, { t: P.T.IN_DOWN, x: .2, y: .4, b: P.BUTTON.LEFT });
  allowed = false; screen.refreshInput();
  assert.ok(f.sent.some(m => m.t === P.T.IN_KEY_UP && m.code === 'ControlLeft'));
  assert.ok(f.sent.some(m => m.t === P.T.IN_UP && m.b === P.BUTTON.LEFT));
});
test('sender renderer loss fails all its sessions and clears queued starts', () => {
  const f = fixture(), sender = new Sender(f.link), states = [];
  sender.on('state', (s, st) => states.push([s, st.status]));
  const session = sender.start({ offer: { kind: 'screen' } });
  sender.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(sender.live.size, 0); assert.equal(sender.queue.length, 0);
  assert.deepEqual(states, [[session, 'failed']]);
});
test('Follow Size respects both dimensions, aspect ratio and native size in both modes', () => {
  for (const ScreenType of [PcScreen, MeshPcScreen]) {
    const context = { cfg: { maxHeight: 'extend' }, _extendSize: () => [1920, 1200] };
    for (const [width, height, expected] of [[1920, 1200, [1920, 1200]], [3840, 2400, [1920, 1200]],
      [3840, 2160, [1920, 1080]], [3840, 1080, [1920, 540]], [1080, 1920, [674, 1200]], [1280, 800, [1280, 800]]]) {
      assert.deepEqual(ScreenType.prototype._streamSize.call(context, { width, height }), expected);
    }
    context._extendSize = () => [2560, 1600];
    assert.deepEqual(ScreenType.prototype._streamSize.call(context, { width: 3840, height: 2400 }), [2560, 1600]);
  }
});
