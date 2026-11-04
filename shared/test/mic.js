// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio › Microphone (shared/mic.js): it tells the other side whether it takes its microphone
// (mic.policy), opens its hidden window only while a switch is on, starts sending only once the other
// side accepts, stops when either side turns off or the link closes, and closes the window when both
// switches are off.
// Run with: node shared/test/mic.js
'use strict';

const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

const wins = [];
const ipc = new EventEmitter();
class FakeWin extends EventEmitter {
  constructor() { super(); this.sent = []; this.dead = false; this.webContents = { send: (ch, m) => this.sent.push(m) }; wins.push(this); }
  loadFile() {}
  isDestroyed() { return this.dead; }
  destroy() { this.dead = true; this.emit('closed'); }
}
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { BrowserWindow: FakeWin, ipcMain: ipc };
  return load.call(this, id, ...args);
};
const { Mic } = require('../mic.js');
Module._load = load;
const T = require('../protocol.js').T;

const link = new EventEmitter();
link.status = { state: 'connected' };
link.out = [];
link.send = (m) => link.out.push(m);
const cfg = { micSend: false, micReceive: false, micDevice: '', micOut: '' };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const mic = new Mic({ link, cfg: () => cfg, platform: 'win' });
  await tick();
  assert.strictEqual(wins.length, 0, 'both off: no window');
  assert.deepStrictEqual(link.out.pop(), { t: T.MIC_POLICY, accept: false, ask: true });

  // Send on, the other side doesn't take it yet: a window (for the device list), nothing sent.
  cfg.micSend = true;
  await mic.apply();
  assert.strictEqual(wins.length, 1);
  const win = wins[0];
  ipc.emit('mic-ready', { sender: win.webContents });
  assert.ok(!win.sent.some((m) => m.t === 'start-send'), 'not accepted: no microphone');

  // The other side accepts: it starts.
  link.emit(T.MIC_POLICY, { t: T.MIC_POLICY, accept: true });
  await tick();
  assert.ok(win.sent.some((m) => m.t === 'start-send'), 'accepted: the microphone goes');
  const session = mic.sending.session;

  // Our offer goes out; a stranger's message on the ipc doesn't.
  ipc.emit('mic-out', { sender: win.webContents }, { t: T.MIC_OFFER, session, sdp: 'x' });
  ipc.emit('mic-out', { sender: {} }, { t: T.MIC_OFFER, session, sdp: 'y' });
  assert.strictEqual(link.out.filter((m) => m.t === T.MIC_OFFER).length, 1);

  // An answer for another session is dropped, ours goes to the window.
  link.emit(T.MIC_ANSWER, { t: T.MIC_ANSWER, session: session + 5, sdp: 'a' });
  link.emit(T.MIC_ANSWER, { t: T.MIC_ANSWER, session, sdp: 'a' });
  assert.strictEqual(win.sent.filter((m) => m.t === T.MIC_ANSWER).length, 1);

  // An offer while we don't receive is ignored.
  link.emit(T.MIC_OFFER, { t: T.MIC_OFFER, session: 1, sdp: 'o' });
  assert.ok(!win.sent.some((m) => m.t === T.MIC_OFFER));

  // The other side turns it off: we stop and say so.
  link.out = [];
  link.emit(T.MIC_POLICY, { t: T.MIC_POLICY, accept: false });
  await tick();
  assert.strictEqual(mic.sending, null);
  assert.ok(win.sent.some((m) => m.t === 'stop-send'));
  assert.ok(link.out.some((m) => m.t === T.MIC_STOP));

  // Receive on: our policy says so, offers reach the window.
  cfg.micReceive = true;
  link.out = [];
  await mic.apply();
  assert.ok(link.out.some((m) => m.t === T.MIC_POLICY && m.accept === true));
  link.emit(T.MIC_OFFER, { t: T.MIC_OFFER, session: 3, sdp: 'o' });
  assert.ok(win.sent.some((m) => m.t === T.MIC_OFFER && m.session === 3));

  // The link closes: sending stops, the other side's acceptance is forgotten.
  link.emit(T.MIC_POLICY, { t: T.MIC_POLICY, accept: true });
  await tick();
  assert.ok(mic.sending);
  link.status.state = 'idle';
  link.emit('closed');
  await tick();
  assert.strictEqual(mic.sending, null);
  assert.strictEqual(mic.peerAccepts, false);

  // Both off: the window goes.
  cfg.micSend = false; cfg.micReceive = false;
  await mic.apply();
  assert.ok(win.dead, 'both off: window closed');
  assert.strictEqual(mic.win, null);

  console.log('mic: passed');
})().catch((e) => { console.error(e); process.exit(1); });
