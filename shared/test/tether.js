// Internet over USB (#277): shared/tether.js with a fake hub, adb and phone. An older phone gets
// nothing; a phone that can gets the offer once it's on the cable; the handshake (a wrong proof is
// refused); a UDP packet through; unplugged, then plugged in again; switched off on the phone.
'use strict';

const assert = require('assert');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Tether, mac } = require('../tether.js');
const R = require('../tetherrelay.js');

const wait = (cond, ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => (cond() ? res() : Date.now() - t0 > ms ? rej(new Error('timed out')) : setTimeout(tick, 10));
  tick();
});

(async () => {
  const server = new EventEmitter();
  const toPhone = [];
  server.sendToClient = (m) => toPhone.push(m);
  const phone = { deviceId: 'ph1', name: 'Pixel', os: 'android' };
  const settings = { hub: { tether: false } };
  let saved = 0;
  const hub = { server, phone, settings: settings.hub, save: () => saved++ };
  const reverses = new Map(); // phone port -> our port
  const adbCalls = [];
  const adb = {
    run: async (args) => {
      adbCalls.push(args.join(' '));
      if (args[2] === 'reverse' && args[3] === '--remove') { reverses.delete(Number(args[4].slice(4))); return { code: 0, out: '', err: '' }; }
      if (args[2] === 'reverse') {
        const p = Number(args[3].slice(4));
        if (p === 31417) return { code: 1, out: '', err: 'error: cannot bind listener: Address already in use' }; // another app holds it
        reverses.set(p, Number(args[4].slice(4)));
        return { code: 0, out: '', err: '' };
      }
      return { code: 0, out: '', err: '' };
    },
  };
  let plugged = true;
  const t = new Tether(hub, { adb, cableSerial: (id) => (plugged && id === 'ph1' ? 'SER1' : null), log: () => {} });
  const say = (m) => server.emit(`t:${m.t}`, m, phone);

  // 1. An older phone (never says tether.state): switched on, nothing goes to it.
  t.started();
  t.act('set', { on: true });
  assert.strictEqual(saved, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(toPhone.length, 0, 'nothing to an older phone');
  assert.strictEqual(t.view.state, 'off');
  console.log('ok: an older phone gets nothing');

  // 2. A phone that can: offered on the next free port of its side.
  say({ t: 'tether.state', can: true, state: 'off' });
  await wait(() => toPhone.some((m) => m.t === 'tether' && m.on));
  const offer = toPhone.find((m) => m.t === 'tether' && m.on);
  assert.strictEqual(offer.port, 31427, 'the next port when 31417 is taken on the phone');
  assert.ok(/^[0-9a-f]{64}$/.test(offer.token));
  assert.strictEqual(reverses.get(31427), t.port);
  assert.strictEqual(t.view.state, 'starting');
  console.log('ok: offered through adb reverse');

  // 3. The handshake: a wrong proof is refused, the right one runs packets.
  const connect = (proof) => new Promise((resolve) => {
    const s = net.connect(reverses.get(offer.port), '127.0.0.1');
    const nonce = crypto.randomBytes(16).toString('hex');
    let buf = '';
    s.on('connect', () => s.write(`TDT1 ${nonce}\n`));
    const onData = (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const [rmac, ours] = buf.slice(0, i).split(' ');
      s.removeListener('data', onData);
      assert.strictEqual(rmac, mac(offer.token, `r${nonce}`), 'the computer proves it knows the token');
      s.write(`${proof(ours)}\n`);
      resolve(s);
    };
    s.on('data', onData);
    s.on('error', () => {});
  });
  const bad = await connect(() => 'f'.repeat(64));
  await new Promise((r) => bad.on('close', r));
  assert.strictEqual(t.view.state, 'starting');
  const good = await connect((ours) => mac(offer.token, `p${ours}`));
  await wait(() => t.view.state === 'on');
  say({ t: 'tether.state', can: true, state: 'on' });
  console.log('ok: handshake (a wrong proof refused)');

  const echo = dgram.createSocket('udp4');
  echo.on('message', (m, r) => echo.send(Buffer.concat([Buffer.from('re:'), m]), r.port, r.address));
  await new Promise((r) => echo.bind(0, '127.0.0.1', r));
  const got = [];
  const packets = new R.Packets((p) => got.push(Buffer.from(p)));
  good.on('data', (d) => packets.push(d));
  const pkt = R.udpPacket('10.215.173.1', 4000, '127.0.0.1', echo.address().port, Buffer.from('ping'));
  good.write(pkt.subarray(0, 10)); // split across writes
  good.write(pkt.subarray(10));
  await wait(() => got.length === 1);
  assert.strictEqual(got[0].subarray(28).toString(), 're:ping');
  assert.ok(t.view.down > 0 && t.view.up > 0);
  console.log('ok: a packet through and back');

  // 4. Unplugged: stopped (off to the phone, reverse removed); plugged in again: offered again.
  toPhone.length = 0;
  plugged = false;
  good.destroy();
  say({ t: 'tether.state', can: true, state: 'off', why: 'stream ended' });
  await wait(() => toPhone.some((m) => m.t === 'tether' && m.on === false));
  assert.strictEqual(reverses.size, 0, 'reverse removed');
  assert.strictEqual(t.view.state, 'cable');
  plugged = true;
  await wait(() => toPhone.some((m) => m.t === 'tether' && m.on), 6000);
  assert.notStrictEqual(toPhone.filter((m) => m.on).pop().token, offer.token, 'a new token');
  console.log('ok: unplugged and plugged in again');

  // 5. Stop on the phone: switched off here, the reverse removed.
  toPhone.length = 0;
  say({ t: 'tether.set', on: false });
  assert.strictEqual(settings.hub.tether, false);
  assert.ok(toPhone.some((m) => m.t === 'tether' && m.on === false));
  assert.strictEqual(reverses.size, 0);
  assert.strictEqual(t.server, null, 'nothing listening');
  console.log('ok: switched off on the phone');

  // 6. The session ends while on.
  t.act('set', { on: true });
  await wait(() => toPhone.some((m) => m.on));
  t.stopped();
  assert.strictEqual(reverses.size, 0);
  assert.strictEqual(t.view.state, 'off');
  t.close();
  echo.close();
  console.log('tether: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
