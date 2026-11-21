// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const P = require('../protocol.js');
let read = () => 'sample copy';
const writes = [];
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { clipboard: { readText: () => read(), writeText: (text) => writes.push(text) } };
  return load.call(this, name, ...args);
};
const { Clipboard } = require('../../mac/clipboard');

(async () => {
  const server = new EventEmitter();
  const helper = new EventEmitter();
  const paired = new Map([['a', {}], ['b', {}]]);
  const cfg = { enabled: true, send: true, receive: true, queue: true, queueLatest: true, maxKB: 256, historySize: 0 };
  const sent = [];
  server.current = null;
  server.sendToClient = () => {};
  server.send = (peer, msg) => sent.push([peer.deviceId, msg.items[0].text]);
  server.outbound = (peer) => peer.ws;
  helper.send = () => {};
  const clip = new Clipboard(server, helper, () => ({ clipboard: cfg }), (peer) => paired.get(peer.deviceId));
  Module._load = load;
  const welcome = (id) => {
    const next = { deviceId: id, ws: { readyState: 1 } };
    server.current = next;
    server.emit('client', next);
    return next;
  };
  const close = () => {
    const prior = server.current;
    server.current = null;
    server.emit('closed', prior);
  };
  const policy = (peer, ws = peer.ws) => server.emit(`t:${P.T.CLIP_POLICY}`, { accept: true, queue: true }, peer, ws);

  welcome('a');
  close();
  await clip._queueNow();
  const owner = welcome('a');
  policy(owner, { readyState: 1 });
  assert.deepEqual(sent, [], 'policy on a retired socket cannot authorize this one');
  policy(owner);
  assert.deepEqual(sent, [['a', 'sample copy']], 'the original pair receives the queue');

  close();
  read = () => 'another sample';
  await clip._queueNow();
  const other = welcome('b');
  policy(other);
  assert.equal(sent.length, 1, 'switching to another pair discards the queue');

  let done;
  read = () => new Promise((resolve) => { done = resolve; });
  const paste = clip._onQueue({ items: [{ text: 'incoming sample' }] }, other, other.ws);
  close();
  welcome('a');
  done('');
  await paste;
  assert.deepEqual(writes, [], 'the old queue cannot paste after a switch');
  console.log('mac-clipboard-queue: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
