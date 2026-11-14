// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/pcnow.js: what plays on the computer, for the phone. Read only while the phone asks
// (pc.media.want), sent on change (pc.media, or {none}), controls go to the player, nothing to a
// computer peer, reading stops when the phone goes.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../protocol.js');
const { PcNow } = require('../pcnow.js');

const server = new EventEmitter();
server.current = { os: P.OS.ANDROID };
const sent = [];
server.sendToClient = (m) => sent.push(m);
const keys = [];
const n = new PcNow({ server, key: (k) => keys.push(k), platform: 'none' });
const media = n.media;
let actives = [];
media.active = (on) => actives.push(!!on);

server.emit(`t:${P.T.PC_MEDIA_WANT}`, { on: true }, server.current);
assert.deepStrictEqual(actives, [true], 'asked: reading starts');
assert.deepStrictEqual(sent.pop(), { t: P.T.PC_MEDIA, none: true }, 'nothing playing yet: none');

media.now = { title: 'On & On', artist: 'Cartoon', album: '', app: 'Firefox', playing: true };
media.emit('change');
assert.deepStrictEqual(sent.pop(), { t: P.T.PC_MEDIA, title: 'On & On', artist: 'Cartoon', album: '', app: 'Firefox', playing: true, art: '' }, 'the first one carries the artwork (none here)');

const did = [];
media.do = (a) => did.push(a);
server.emit(`t:${P.T.PC_MEDIA_CTL}`, { a: 'prev' }, server.current);
server.emit(`t:${P.T.PC_MEDIA_CTL}`, { a: 'toggle' }, server.current);
server.emit(`t:${P.T.PC_MEDIA_CTL}`, { a: 'rm -rf' }, server.current);
assert.deepStrictEqual(did, ['previous', 'toggle'], 'only known controls, prev as previous');

const pc = { os: 'win' };
server.emit(`t:${P.T.PC_MEDIA_CTL}`, { a: 'next' }, pc);
assert.deepStrictEqual(did, ['previous', 'toggle'], 'a computer peer controls nothing');

server.emit('closed', server.current);
assert.deepStrictEqual(actives, [true, false], 'the phone went: reading stops');
media.emit('change');
assert.strictEqual(sent.length, 0, 'not asked: nothing sent');

console.log('pcnow ok');
