'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const P = require('../protocol');
let text = '', read = async () => text;
const clipboard = { readText: () => read(), writeText: async value => { text = value; } };
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { clipboard };
  if (id.endsWith('/clipimage.js')) return { ClipImages: class { text() {} reset() {} }, trimPictures() {}, itemView() {} };
  return load.call(this, id, ...args);
};
const { Clipboard } = require('../../mac/clipboard');
Module._load = load;
(async () => {
  const sent = [], server = Object.assign(new EventEmitter(), { current: { name: 'peer' }, sendToClient: m => sent.push(m) });
  const helper = Object.assign(new EventEmitter(), { request: async () => ({}), send() {} });
  const settings = { clipboard: { enabled: true, send: true, receive: true, maxKB: 1024, historySize: 0 }, files: {} };
  const c = new Clipboard(server, helper, () => settings);
  const copies = () => sent.filter(m => m.t === P.T.CLIP).map(m => m.text);
  text = 'A'; await c.sendIfChanged('request');
  await c._onClip({ text: 'B' }); await c.sendIfChanged('request');
  server.emit('client', server.current); await c.sendIfChanged('request');
  text = 'A'; await c.sendIfChanged('request');
  assert.deepEqual(copies(), ['A', 'A'], 'repeat after remote copy; no echo after reconnect');

  let release, entered;
  const atHelper = new Promise(resolve => { entered = resolve; });
  helper.request = () => new Promise(resolve => { release = resolve; entered(); });
  text = 'old'; const pending = c.sendIfChanged('request'); await atHelper;
  await c._onClip({ text: 'new' }); release({}); await pending;
  assert.deepEqual(copies(), ['A', 'A'], 'stale read does not overwrite incoming copy');
  assert.equal(text, 'new');

  let finishRead, readStarted;
  const atRead = new Promise(resolve => { readStarted = resolve; });
  read = () => new Promise(resolve => { finishRead = resolve; readStarted(); });
  const incoming = c._onClip({ text: 'newer' }); await atRead;
  c.applySettings(); finishRead('new'); await incoming;
  assert.equal(text, 'newer', 'settings refresh does not cancel receive');
  assert.equal(c.lastReceived, 'newer');
  console.log('mac-clipboard-repeat: repeat, reconnect and in-flight receive pass');
})().catch(e => { console.error(e); process.exitCode = 1; });
