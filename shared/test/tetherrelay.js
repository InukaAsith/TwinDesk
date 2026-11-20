// Internet over USB (#277): shared/tetherrelay.js answering a phone's packets. This plays the
// phone's TCP stack: handshake, a megabyte each way with a small window, FIN both ways, a refused
// port, a reset, UDP and the DNS redirect.
'use strict';

const assert = require('assert');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const R = require('../tetherrelay.js');

const PHONE = '10.215.173.1';
const sum = (p, s, e, a) => R.sum16(p, s, e, a);

function checkPacket(p) {
  assert.strictEqual(p[0], 0x45);
  assert.strictEqual(R.fold(sum(p, 0, 20)), 0, 'IP checksum');
  const proto = p[9];
  const l4 = p.length - 20;
  const acc = sum(p, 12, 20) + proto + l4;
  assert.strictEqual(R.fold(sum(p, 20, p.length, acc)), 0, `${proto} checksum`);
}

// The phone's side of one connection.
class Phone {
  constructor(relay, dst, dport, { window = 8192, sport = 40000 + Math.floor(Math.random() * 20000) } = {}) {
    Object.assign(this, { relay, dst, dport, window, sport });
    this.seq = 1000;
    this.ack = 0;
    this.got = [];
    this.gotLen = 0;
    this.fin = false;
    this.rst = false;
    this.synAck = false;
    this.mss = 0;
    this.inbox = [];
  }

  f() {
    return { src: this.dst, sport: this.dport, dst: PHONE, dport: this.sport }; // as tcpPacket builds "from far end to phone", swapped
  }

  // A TCP packet from the phone (tcpPacket writes from f.dport to f.sport, from f.dst to f.src).
  send(flags, payload, opts) {
    const f = { src: this.dst, sport: this.dport, dst: PHONE, dport: this.sport };
    const p = R.tcpPacket(f, flags, this.seq, this.ack, this.window, payload, opts);
    this.relay.feed(p);
    this.seq = (this.seq + (payload ? payload.length : 0) + ((flags & (R.SYN | R.FIN)) ? 1 : 0)) >>> 0;
  }

  take(p) {
    const off = 20;
    const flags = p[off + 13];
    const doff = (p[off + 12] >> 4) * 4;
    const data = p.subarray(off + doff);
    if (flags & R.RST) { this.rst = true; return; }
    if (flags & R.SYN) {
      this.synAck = true;
      this.ack = (p.readUInt32BE(off + 4) + 1) >>> 0;
      this.mss = p.readUInt16BE(off + 22);
      this.send(R.ACK);
      return;
    }
    if (data.length) {
      assert.ok(data.length <= this.window, 'within the window');
      this.got.push(Buffer.from(data));
      this.gotLen += data.length;
      this.ack = (this.ack + data.length) >>> 0;
    }
    if (flags & R.FIN) { this.fin = true; this.ack = (this.ack + 1) >>> 0; }
    if (data.length || (flags & R.FIN)) this.send(R.ACK);
  }
}

const wait = (cond, ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => (cond() ? res() : Date.now() - t0 > ms ? rej(new Error('timed out')) : setTimeout(tick, 5));
  tick();
});

(async () => {
  const phones = new Map();
  const udpIn = [];
  const relay = new R.Relay((p) => {
    checkPacket(p);
    if (p[9] === 17) { udpIn.push(p); return; }
    const key = p.readUInt16BE(22); // the phone's port
    const ph = phones.get(key);
    if (ph) setImmediate(() => ph.take(p)); // a little later, as through adb
  }, { dnsServer: '127.0.0.1' });

  // A server: echoes each connection's bytes, plus a megabyte once it's had a megabyte.
  const big = crypto.randomBytes(1 << 20);
  const srv = net.createServer((s) => {
    const parts = [];
    let n = 0;
    s.on('data', (d) => { parts.push(d); n += d.length; if (n === big.length) { assert.ok(Buffer.concat(parts).equals(big), 'server got the megabyte'); s.end(big); } });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  // 1. Handshake, a megabyte each way through an 8 KB window, FIN both ways.
  const a = new Phone(relay, '127.0.0.1', port);
  phones.set(a.sport, a);
  const mss = Buffer.from([2, 4, 0x05, 0xb4]); // 1460
  a.send(R.SYN, null, mss);
  await wait(() => a.synAck);
  assert.strictEqual(a.mss, R.MTU - 40, 'our MSS');
  for (let i = 0; i < big.length; i += 1460) a.send(R.ACK | R.PSH, big.subarray(i, i + 1460));
  await wait(() => a.gotLen === big.length && a.fin, 10000);
  assert.ok(Buffer.concat(a.got).equals(big), 'the phone got the megabyte in order');
  assert.ok(a.got.every((g) => g.length <= 1460), 'segments within the phone MSS');
  a.send(R.FIN | R.ACK);
  await wait(() => relay.tcp.size === 0);
  console.log('ok: handshake, 1 MB each way, FIN both ways');

  // 2. A port nothing listens on: reset.
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const freePort = free.address().port;
  await new Promise((r) => free.close(r));
  const b = new Phone(relay, '127.0.0.1', freePort);
  phones.set(b.sport, b);
  b.send(R.SYN, null, mss);
  await wait(() => b.rst);
  assert.strictEqual(relay.tcp.size, 0);
  console.log('ok: refused port answers RST');

  // 3. The phone resets a connection: the socket here closes.
  let closedHere = false;
  const srv2 = net.createServer((s) => { s.on('close', () => { closedHere = true; }); s.on('error', () => {}); });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const c = new Phone(relay, '127.0.0.1', srv2.address().port);
  phones.set(c.sport, c);
  c.send(R.SYN, null, mss);
  await wait(() => c.synAck);
  c.send(R.RST | R.ACK);
  await wait(() => closedHere && relay.tcp.size === 0);
  console.log('ok: phone RST closes the socket');

  // 4. A stray ACK for nothing open: RST.
  const d = new Phone(relay, '127.0.0.1', port);
  phones.set(d.sport, d);
  d.send(R.ACK, Buffer.from('x'));
  await wait(() => d.rst);
  console.log('ok: stray segment answered RST');

  // 5. UDP: an echo server, and DNS to the VPN's DNS address going to this computer's DNS server.
  const echo = dgram.createSocket('udp4');
  echo.on('message', (m, r) => echo.send(Buffer.concat([Buffer.from('re:'), m]), r.port, r.address));
  await new Promise((r) => echo.bind(0, '127.0.0.1', r));
  const ep = echo.address().port;
  relay.feed(R.udpPacket(PHONE, 5555, '127.0.0.1', ep, Buffer.from('hello')));
  await wait(() => udpIn.length === 1);
  let p = udpIn[0];
  assert.strictEqual(p.subarray(28).toString(), 're:hello');
  assert.strictEqual(`${p[12]}.${p[13]}.${p[14]}.${p[15]}`, '127.0.0.1');
  assert.strictEqual(p.readUInt16BE(22), 5555);
  relay.dnsPort = ep; // the "DNS server" is the echo
  relay.feed(R.udpPacket(PHONE, 5556, R.DNS_IP, 53, Buffer.from('query')));
  await wait(() => udpIn.length === 2);
  p = udpIn[1];
  assert.strictEqual(p.subarray(28).toString(), 're:query');
  assert.strictEqual(`${p[12]}.${p[13]}.${p[14]}.${p[15]}`, R.DNS_IP, 'the answer comes from the VPN DNS address');
  assert.strictEqual(p.readUInt16BE(20), 53);
  console.log('ok: UDP and the DNS redirect');

  // 6. The stream splitter.
  const seen = [];
  const pk = new R.Packets((x) => seen.push(x.length));
  const one = R.udpPacket(PHONE, 1, '1.1.1.1', 2, Buffer.alloc(100));
  const two = R.udpPacket(PHONE, 1, '1.1.1.1', 2, Buffer.alloc(300));
  const both = Buffer.concat([one, two]);
  assert.ok(pk.push(both.subarray(0, 50)));
  assert.ok(pk.push(both.subarray(50, 200)));
  assert.ok(pk.push(both.subarray(200)));
  assert.deepStrictEqual(seen, [one.length, two.length]);
  assert.strictEqual(new R.Packets(() => {}).push(Buffer.alloc(40, 0x60)), false, 'IPv6 or junk breaks the stream');
  console.log('ok: packet splitter');

  relay.close();
  echo.close();
  srv.close();
  srv2.close();
  console.log('tetherrelay: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
