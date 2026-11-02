'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../shared/protocol');
function fixture() {
  const sent = [], wins = [], callbacks = {}; let enabled = true;
  const video = { videoWidth: 100, videoHeight: 100, srcObject: {}, addEventListener() {} };
  function createWindow() {
    const events = {}, frames = [];
    const win = { innerWidth: 100, innerHeight: 100, closed: false, frames, events,
      addEventListener: (n, fn) => { events[n] = fn; }, requestAnimationFrame: fn => frames.push(fn),
      setTimeout() {}, close() { this.closed = true; events.unload(); },
      document: { title: '', querySelector: () => ({}), body: { style: {}, append() {} }, documentElement: { style: {} }, createElement: () => ({ style: {}, play: async () => {} }) },
    }; wins.push(win); return win;
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../monitor-apps.js'), 'utf8'), {
    window: { PlayerI18n: require('./support/player-i18n.js'), MacShareProtocol: P, monitorInputEnabled: () => enabled, open: createWindow,
      monitor: { send: m => sent.push(m), onAppWindows: fn => { callbacks.list = fn; }, onInputEnabled: fn => { callbacks.input = fn; } } },
    document: { getElementById: () => video },
  });
  const list = [{ wid: 1, title: 'app', x: 0, y: 0, w: 1, h: 1 }]; callbacks.list(list);
  return { sent, wins, callbacks, list, win: wins[0], enable(on) { enabled = on; callbacks.input(on); },
    event: extra => ({ clientX: 30, clientY: 40, button: 0, code: 'KeyA', preventDefault() {}, ...extra }) };
}
test('app blur discards pending movement rather than sending it after focus leaves', () => {
  const f = fixture(); f.win.events.mousemove(f.event()); f.win.events.blur(); f.win.frames[0](); assert.equal(f.sent.length, 0);
});
test('app click flushes preceding movement before mouse down', () => {
  const f = fixture(); f.win.events.mousemove(f.event()); f.win.events.mousedown(f.event()); f.win.frames[0]();
  assert.deepEqual(f.sent.map(m => m.t), [P.T.IN_MOVE, P.T.IN_DOWN]);
});
test('app wheel flushes preceding movement before scrolling', () => {
  const f = fixture(); f.win.events.mousemove(f.event()); f.win.events.wheel(f.event({ deltaX: 0, deltaY: 1 }));
  assert.deepEqual(f.sent.map(m => m.t), [P.T.IN_MOVE, P.T.IN_WHEEL]);
});
test('closing app releases held keys and buttons before remote close', () => {
  const f = fixture(); f.win.events.keydown(f.event()); f.win.events.mousedown(f.event()); f.sent.length = 0; f.win.close();
  assert.deepEqual(f.sent.map(m => m.t), [P.T.IN_KEY_UP, P.T.IN_UP, P.T.APP_CLOSE]);
});
test('remote app removal releases input without sending a remote close', () => {
  const f = fixture(); f.win.events.keydown(f.event()); f.sent.length = 0; f.callbacks.list([]);
  assert.deepEqual(f.sent.map(m => m.t), [P.T.IN_KEY_UP]); assert.equal(f.win.closed, true);
});
test('policy changes clear pending movement and held input before reenable', () => {
  const f = fixture(); f.win.events.keydown(f.event()); f.win.events.mousemove(f.event()); f.sent.length = 0;
  f.enable(false); f.enable(true); f.win.events.blur(); f.win.frames[0](); assert.equal(f.sent.length, 0);
});
test('disabled app input is not recorded and replayed after reenable', () => {
  const f = fixture(); f.enable(false); f.win.events.keydown(f.event()); f.win.events.mousedown(f.event()); f.win.events.mousemove(f.event());
  f.enable(true); f.win.events.blur(); for (const frame of f.win.frames) frame(); assert.equal(f.sent.length, 0);
});
test('old window unload cannot close or remove its replacement', () => {
  const f = fixture(); f.win.closed = true; f.callbacks.list(f.list); const replacement = f.wins[1];
  f.win.events.unload(); assert.equal(f.sent.length, 0); f.callbacks.list(f.list); assert.equal(f.wins.length, 2);
  f.callbacks.list([]); assert.equal(replacement.closed, true);
});

test('repeated enabled notifications do not forget keys still held in an app', () => {
  const f = fixture(); f.win.events.keydown(f.event()); f.sent.length = 0;
  f.enable(true); f.win.events.blur(); assert.deepEqual(f.sent.map(m => m.t), [P.T.IN_KEY_UP]);
});
