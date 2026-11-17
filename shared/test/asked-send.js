// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos › Save / Files › Save with Accept files off (#239). The phone answers with an ordinary
// file.offer drop:'send'. There is no id tying that offer to the save, so the first Send on the
// authenticated session that asked is the one allowed — not a check that the bytes are those
// photos or paths. Mac Drop takes that one transfer in one-to-one (the ctx itself) and in mesh
// (a fresh view of the same conn, from the shared route). One that works, and one where nothing else may.
// Run with: node shared/test/asked-send.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const P = require('../protocol.js');

const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { shell: { showItemInFolder() {} }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } };
  return load.call(this, id, ...args);
};
const { Drop } = require('../../mac/drop.js');
const { PhoneHub } = require('../phonehub.js');
const { wireAsked } = require('../asked-send.js');
const { Route, viewOf } = require('../hub-route.js');
Module._load = load;

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-send-'));
  const sent = [];
  const server = Object.assign(new EventEmitter(), {
    current: null,
    sendToClient: (m) => sent.push(m),
  });
  const settings = { files: { acceptDrops: false, reveal: false, clipReceived: false, folder: dir }, hub: { media: true, files: true, calls: false, messages: false } };
  const drop = new Drop({
    server,
    helper: Object.assign(new EventEmitter(), { request: async () => ({}), send() {} }),
    displays: { target: () => null },
    getSettings: () => settings,
  });
  const hub = new PhoneHub({ server, getSettings: () => settings, save() {} });
  const windowsAsked = [];
  hub.on('asked', () => windowsAsked.push(true)); // Windows/Linux ignore the session and open their own window
  wireAsked(hub, drop);
  const offer = (m, ctx) => server.emit(`t:${P.T.FILE_OFFER}`, m, ctx);
  return { dir, sent, server, settings, drop, hub, offer, windowsAsked };
}

function hostSession(ctx) {
  return {
    id: ctx.deviceId,
    displayName: () => ctx.name || 'Pixel',
    peerOs: ctx.os,
    role: 'guest',
    transport: 'ip',
    status: { rtt: 1 },
    lastRx: 1,
    hostUp: true,
    linkUp: false,
    ctx,
    link: null,
    connected: true,
    send: () => true,
  };
}

// Mesh: every read of the phone is a new view. `conn` is the authenticated session.
function mesh(ctx) {
  return viewOf(hostSession(ctx));
}

function guestView(deviceId, ws) {
  return viewOf({
    id: deviceId,
    displayName: () => 'Pixel',
    peerOs: P.OS.ANDROID,
    role: 'host',
    transport: 'ip',
    status: { rtt: null },
    lastRx: 0,
    hostUp: false,
    linkUp: true,
    ctx: null,
    link: { ws, pairing: { address: '10.0.0.9' } },
    connected: true,
    send: () => true,
  });
}

function refused(sent, id) {
  return sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === id && m.why === 'not_allowed');
}

// The shared route's fresh views name one session. deliver() does not reuse current.
{
  const ctx = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, address: '10.0.0.8', ws: { id: 'sock' }, rttMs: 4 };
  const hub = { sessions: new Map([[ctx.deviceId, hostSession(ctx)]]) };
  const route = new Route(hub, () => ctx.deviceId);
  route.refresh();
  assert.strictEqual(route.current.conn, ctx, 'the route view points at the host session');
  const seen = [];
  route.on(`t:${P.T.FILE_OFFER}`, (m, v) => seen.push(v));
  assert.strictEqual(route.deliver({ t: P.T.FILE_OFFER, id: 'x' }), true);
  assert.strictEqual(seen[0].conn, ctx);
  assert.notStrictEqual(seen[0], route.current, 'each read is a new view of that session');
  const dead = viewOf({ ...hostSession(ctx), ctx: { authed: false, deviceId: ctx.deviceId } });
  assert.strictEqual(dead.conn, null, 'a view with no live session is not itself the session');
  const ws = { readyState: 1 };
  assert.strictEqual(guestView(ctx.deviceId, ws).conn, ws, 'a guest link\'s socket is the session');
  console.log('  route: fresh views share one authenticated connection');
}

// ---- it works: this session's Save is taken, and only that transfer ----
(async () => {
  const a = setup();
  const conn = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'sock' } };
  try {
    a.server.current = mesh(conn);
    a.server.emit('client', a.server.current);
    const before = a.sent.length;
    a.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['42'] } });
    assert.ok(a.sent.slice(before).some((m) => m.t === P.T.MEDIA_SAVE && m.ids[0] === '42'), 'the phone was asked');
    assert.strictEqual(a.windowsAsked.length, 1, 'a listener that ignores the session still hears asked');

    // The offer is not the media id. The first Send on this session consumes the allowance.
    const body = Buffer.from('photo');
    const from = mesh(conn); // not the object PhoneHub handed to Drop
    assert.notStrictEqual(from, a.server.current);
    assert.strictEqual(from.conn, conn);
    a.offer({ t: P.T.FILE_OFFER, id: 'p1', name: 'notes.txt', size: body.length, drop: 'send', batch: 'not-42', count: 1 }, from);
    await until(() => a.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'p1'));
    a.server.emit(`t:${P.T.FILE_CHUNK}`, { t: P.T.FILE_CHUNK, id: 'p1', seq: 0, data: body });
    a.server.emit(`t:${P.T.FILE_END}`, { t: P.T.FILE_END, id: 'p1', sha256: sha(body) });
    await until(() => a.sent.some((m) => m.t === P.T.FILES_DONE && m.batch === 'not-42' && m.ok));
    assert.strictEqual(fs.readFileSync(path.join(a.dir, 'notes.txt')).equals(body), true, 'the first Send on that session is saved');
    assert.ok(!fs.existsSync(path.join(a.dir, '42')), 'the save id is not treated as the file');

    a.offer({ t: P.T.FILE_OFFER, id: 'p2', name: 'other.jpg', size: 1, drop: 'send', batch: 'save-2', count: 1 }, mesh(conn));
    assert.ok(refused(a.sent, 'p2'), 'a second transfer is not part of that Save');
    console.log('  main: the asked session\'s one Send is saved; it is not matched to the save payload');
  } finally {
    a.drop.clearAsked();
    fs.rmSync(a.dir, { recursive: true, force: true });
  }

  // Direct: the ctx is the session. No mesh view, no conn field.
  const direct = setup();
  const raw = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'single' } };
  try {
    direct.server.current = raw;
    direct.server.emit('client', raw);
    direct.hub.act({ do: 'send', msg: { t: P.T.FS_SAVE, paths: ['DCIM/Camera/PXL_1.jpg'] } });
    const body = Buffer.from('direct');
    direct.offer({ t: P.T.FILE_OFFER, id: 'd1', name: 'PXL_1.jpg', size: body.length, drop: 'send', batch: 'direct-1', count: 2 }, raw);
    assert.ok(direct.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'd1'), 'the same connection\'s first file is accepted');
    direct.offer({ t: P.T.FILE_OFFER, id: 'd2', name: 'PXL_2.jpg', size: 1, drop: 'send', batch: 'direct-1', count: 2 }, raw);
    assert.ok(direct.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'd2'), 'a later file of that batch is checked again and allowed');
    const replaced = { authed: true, deviceId: raw.deviceId, name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'later' } };
    direct.offer({ t: P.T.FILE_OFFER, id: 'd3', name: 'PXL_3.jpg', size: 1, drop: 'send', batch: 'direct-1', count: 2 }, replaced);
    assert.ok(refused(direct.sent, 'd3'), 'a replaced connection does not continue the batch');
    console.log('  direct: one batch on that connection; a later file is rechecked');
  } finally {
    direct.drop.clearAsked();
    fs.rmSync(direct.dir, { recursive: true, force: true });
  }

  // Guest mesh: the dialled socket is the session. The next dial is not.
  const guest = setup();
  const sock = { readyState: 1 };
  try {
    const first = guestView('pixel-1', sock);
    guest.server.current = first;
    guest.server.emit('client', first);
    guest.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['9'] } });
    guest.offer({ t: P.T.FILE_OFFER, id: 'g1', name: 'a.jpg', size: 1, drop: 'send', batch: 'guest-1', count: 1 }, guestView('pixel-1', sock));
    assert.ok(guest.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'g1'));
    guest.offer({ t: P.T.FILE_OFFER, id: 'g2', name: 'b.jpg', size: 1, drop: 'send', batch: 'guest-2', count: 1 }, guestView('pixel-1', { readyState: 1 }));
    assert.ok(refused(guest.sent, 'g2'), 'the next dial is a new session');
    console.log('  mesh guest: the socket, not the device id, is the session');
  } finally {
    guest.drop.clearAsked();
    fs.rmSync(guest.dir, { recursive: true, force: true });
  }

  // ---- nothing else: not asked, not this session, stopped, forgotten, or too late ----
  const b = setup();
  const phone = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'sock' } };
  try {
    assert.strictEqual(b.drop.allowAsked({ os: P.OS.ANDROID, deviceId: 'pixel-1' }), false, 'a session that has not authenticated grants nothing');
    assert.strictEqual(b.drop.allowAsked(viewOf({ ...hostSession(phone), ctx: { authed: false, deviceId: phone.deviceId } })), false);
    b.server.current = mesh(phone);
    b.server.emit('client', b.server.current);
    b.offer({ t: P.T.FILE_OFFER, id: 'no', name: 'x.jpg', size: 1, drop: 'send', batch: 'u', count: 1 }, mesh(phone));
    assert.ok(refused(b.sent, 'no'), 'a Send nobody asked for is refused');

    b.hub.act({ do: 'send', msg: { t: P.T.FS_SAVE, paths: ['DCIM/Camera/PXL_1.jpg'] } });
    // A continuation of some older batch is not the Save. The allowance stays for a new batch.
    b.offer({ t: P.T.FILE_OFFER, id: 'old-cont', name: 'x.jpg', size: 1, drop: 'send', batch: 'rest', count: 1, cont: 'older' }, mesh(phone));
    assert.ok(refused(b.sent, 'old-cont'), 'the first offer must be a new batch; a continuation does not consume the allowance');
    b.offer({ t: P.T.FILE_OFFER, id: 'took', name: 'unrelated.bin', size: 1, drop: 'send', batch: 'took', count: 1 }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'took'), 'the first new Send on this session is allowed, whatever it contains');

    const other = { authed: true, deviceId: 'other', name: 'Other', os: P.OS.ANDROID, ws: {} };
    b.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['7'] } });
    b.offer({ t: P.T.FILE_OFFER, id: 'cross', name: 'x.jpg', size: 1, drop: 'send', batch: 'c', count: 1 }, mesh(other));
    const replaced = { authed: true, deviceId: phone.deviceId, name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'next' } };
    b.offer({ t: P.T.FILE_OFFER, id: 'replay', name: 'x.jpg', size: 1, drop: 'send', batch: 'r', count: 1 }, mesh(replaced));
    b.offer({ t: P.T.FILE_OFFER, id: 'point', name: 'x.jpg', size: 1, drop: 'point', x: 0, y: 0 }, mesh(phone));
    b.server.emit('closed', mesh(phone));
    b.offer({ t: P.T.FILE_OFFER, id: 'stopped', name: 'x.jpg', size: 1, drop: 'send', batch: 's', count: 1 }, mesh(phone));
    b.server.current = mesh(phone);
    b.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['7'] } });
    b.hub.forget(false);
    b.offer({ t: P.T.FILE_OFFER, id: 'forgot', name: 'x.jpg', size: 1, drop: 'send', batch: 'f', count: 1 }, mesh(phone));
    const lone = { authed: true, deviceId: 'pixel-1', os: P.OS.ANDROID, ws: { id: 'single' } };
    b.drop.allowAsked(lone);
    b.offer({ t: P.T.FILE_OFFER, id: 'raw-next', name: 'x.jpg', size: 1, drop: 'send', batch: 'n', count: 1 }, { authed: true, deviceId: 'pixel-1', os: P.OS.ANDROID, ws: { id: 'later' } });
    b.drop.allowAsked(guestView('pixel-1', sockHolder()));
    b.offer({ t: P.T.FILE_OFFER, id: 'guest-next', name: 'x.jpg', size: 1, drop: 'send', batch: 'g', count: 1 }, guestView('pixel-1', { readyState: 1 }));
    b.drop.allowAsked(mesh(phone), 20);
    await sleep(40);
    b.offer({ t: P.T.FILE_OFFER, id: 'late', name: 'x.jpg', size: 1, drop: 'send', batch: 't', count: 1 }, mesh(phone));

    for (const id of ['cross', 'replay', 'point', 'raw-next', 'guest-next', 'stopped', 'forgot', 'late']) {
      assert.ok(b.sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === id), `${id} was not refused`);
    }
    assert.ok(!b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id !== 'took'), 'none of those offers were accepted');
    console.log('  failure: unsolicited, other device, replacement, Stop, Forget and timeout stay refused');

    // Existing batch: later files and a continuation are checked again, on this connection only.
    b.drop.allowAsked(mesh(phone));
    const part = { t: P.T.FILE_OFFER, name: 'part.jpg', size: 1, drop: 'send', batch: 'partial', count: 3 };
    b.offer({ ...part, id: 'first' }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'first'));
    b.offer({ ...part, id: 'second' }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'second'), 'the next file of the open batch is allowed');
    b.offer({ ...part, id: 'other-session' }, mesh(other));
    b.offer({ t: P.T.FILE_OFFER, id: 'cont-ok', name: 'rest.jpg', size: 1, drop: 'send', batch: 'partial-rest', count: 2, cont: 'partial' }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'cont-ok'), 'a continuation of that batch is the same transfer');
    b.offer({ t: P.T.FILE_OFFER, id: 'cont-next', name: 'rest-2.jpg', size: 1, drop: 'send', batch: 'partial-rest', count: 2, cont: 'partial' }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'cont-next'), 'a later file of the continuation is checked again');
    b.hub.stopped();
    b.offer({ ...part, id: 'after-stop' }, mesh(phone));
    b.offer({ t: P.T.FILE_OFFER, id: 'cont-stopped', name: 'rest-3.jpg', size: 1, drop: 'send', batch: 'partial-rest', count: 2, cont: 'partial' }, mesh(phone));
    for (const id of ['other-session', 'after-stop', 'cont-stopped']) {
      assert.ok(b.sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === id), `${id} continued a revoked batch`);
    }

    b.server.current = mesh(phone);
    b.drop.allowAsked(mesh(phone), 25);
    b.offer({ ...part, id: 'tick-1', batch: 'tick' }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'tick-1'));
    await sleep(40);
    b.offer({ ...part, id: 'tick-2', batch: 'tick' }, mesh(phone));
    assert.ok(refused(b.sent, 'tick-2'), 'a later file is refused once the wait has run out');

    b.drop.allowAsked(mesh(phone));
    b.offer({ ...part, id: 'swap-1', batch: 'swap' }, mesh(phone));
    b.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['8'] } });
    b.offer({ ...part, id: 'swap-2', batch: 'swap' }, mesh(phone));
    assert.ok(refused(b.sent, 'swap-2'), 'a later Save replaces the open batch\'s allowance');
    b.offer({ t: P.T.FILE_OFFER, id: 'swap-new', name: 'new.jpg', size: 1, drop: 'send', batch: 'swap-new', count: 1 }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'swap-new'), 'the Send after the latest ask is the one allowed');
    console.log('  continuation: an open batch and its cont files are rechecked; Stop, timeout and a later Save revoke them');
  } finally {
    b.drop.clearAsked();
    fs.rmSync(b.dir, { recursive: true, force: true });
  }

  // Accept files on does not need a grant, and turning it off does not leave a window.
  const open = setup();
  try {
    const ctx = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'sock' } };
    open.server.current = mesh(ctx);
    open.settings.files.acceptDrops = true;
    open.offer({ t: P.T.FILE_OFFER, id: 'on', name: 'a.jpg', size: 1, drop: 'send', batch: 'on', count: 1 }, mesh(ctx));
    assert.ok(open.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'on'), 'Accept files on still takes a Send nobody asked for');
    open.settings.files.acceptDrops = false;
    open.offer({ t: P.T.FILE_OFFER, id: 'off', name: 'b.jpg', size: 1, drop: 'send', batch: 'off', count: 1 }, mesh(ctx));
    assert.ok(refused(open.sent, 'off'), 'turning Accept files off does not leave a blanket window');
    open.offer({ t: P.T.FILE_OFFER, id: 'paste', name: 'c.jpg', size: 1, drop: 'paste', batch: 'paste', count: 1 }, mesh(ctx));
    assert.ok(refused(open.sent, 'paste'), 'a paste nobody prepared is still refused');
    console.log('  accept on: unchanged; no blanket window when it is off');
  } finally {
    open.drop.clearAsked();
    fs.rmSync(open.dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function sockHolder() {
  return { readyState: 1 };
}
