// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos › Save / Files › Save with Accept files off (#239). The phone answers with an ordinary
// file.offer drop:'send'. There is no id tying that offer to the save, so the first Send on the
// authenticated socket that asked is the one allowed — not a check that the bytes are those
// photos or paths. file.offer has no id for the Save, so the first new batch on that socket is
// taken: that limit stays. Mac Drop takes that one transfer in one-to-one (the ctx's socket)
// and in mesh (the socket the route's source() reports, not a view built to look the same).
// One that works, and one where nothing else may.
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
const sock = (id) => ({ id, readyState: 1 });

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
  const offer = (m, ctx, ws) => server.emit(`t:${P.T.FILE_OFFER}`, m, ctx, ws);
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

// The shared route's fresh views name one socket. deliver(msg, ingress) keeps that socket;
// it does not rebuild the view as whichever connection send() would use now.
{
  const ctx = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, address: '10.0.0.8', ws: sock('sock'), rttMs: 4 };
  const hub = { sessions: new Map([[ctx.deviceId, hostSession(ctx)]]) };
  const route = new Route(hub, () => ctx.deviceId);
  route.refresh();
  assert.strictEqual(route.current.conn, ctx.ws, 'the route view points at the host socket send() uses');
  assert.strictEqual(route.current.source(), ctx.ws);
  const seen = [];
  route.on(`t:${P.T.FILE_OFFER}`, (m, v) => seen.push(v));
  assert.strictEqual(route.deliver({ t: P.T.FILE_OFFER, id: 'x' }, ctx.ws), true);
  assert.strictEqual(seen[0].conn, ctx.ws);
  assert.strictEqual(seen[0].source(), ctx.ws, 'the offer carries the socket it arrived on');
  assert.notStrictEqual(seen[0], route.current, 'each read is a new view of that session');
  const bare = [];
  route.on(`t:${P.T.FILE_OFFER}`, (m, v) => bare.push(v));
  route.deliver({ t: P.T.FILE_OFFER, id: 'bare' }, null);
  assert.strictEqual(bare[bare.length - 1].conn, null, 'a message with no ingress is not the current route');
  assert.strictEqual(bare[bare.length - 1].source(), null);
  const dead = viewOf({ ...hostSession(ctx), ctx: { authed: false, deviceId: ctx.deviceId, ws: ctx.ws } });
  assert.strictEqual(dead.conn, null, 'a view with no live session is not itself the session');
  const ws = { readyState: 1 };
  assert.strictEqual(guestView(ctx.deviceId, ws).conn, ws, 'a guest link\'s socket is the session');
  const guestWs = sock('guest');
  const both = hostSession(ctx);
  both.linkUp = true;
  both.link = { ws: guestWs, authed: true, pairing: { address: '10.0.0.9' } };
  const overlap = viewOf(both);
  assert.strictEqual(overlap.conn, guestWs, 'both up: conn is the guest socket send() uses');
  assert.strictEqual(overlap.ws, ctx.ws, 'both up: the view ws field still prefers the host ctx');
  const overlapRoute = new Route({ sessions: new Map([[ctx.deviceId, both]]) }, () => ctx.deviceId);
  overlapRoute.refresh();
  const sides = [];
  overlapRoute.on(`t:${P.T.FILE_OFFER}`, (m, v) => sides.push(v));
  overlapRoute.deliver({ t: P.T.FILE_OFFER, id: 'host-side' }, ctx.ws);
  overlapRoute.deliver({ t: P.T.FILE_OFFER, id: 'guest-side' }, guestWs);
  assert.strictEqual(sides[0].source(), ctx.ws, 'a host ingress stays the host socket');
  assert.strictEqual(sides[1].source(), guestWs, 'a guest ingress stays the guest socket');
  assert.notStrictEqual(sides[0].conn, overlapRoute.current.conn, 'deliver does not substitute the outbound socket');
  console.log('  route: fresh views name the socket that was used, not the host ctx');
}

// ---- it works: this session's Save is taken, and only that transfer ----
(async () => {
  const a = setup();
  const conn = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: sock('sock') };
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
    assert.strictEqual(from.conn, conn.ws);
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
  const raw = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: sock('single') };
  try {
    direct.server.current = raw;
    direct.server.emit('client', raw);
    direct.hub.act({ do: 'send', msg: { t: P.T.FS_SAVE, paths: ['DCIM/Camera/PXL_1.jpg'] } });
    const body = Buffer.from('direct');
    const first = { t: P.T.FILE_OFFER, id: 'd1', name: 'PXL_1.jpg', size: body.length, drop: 'send', batch: 'direct-1', count: 2 };
    raw.alt = sock('fallback');
    direct.offer({ ...first, id: 'd-fallback' }, raw, raw.alt);
    assert.ok(refused(direct.sent, 'd-fallback'), 'the same ctx on a different ingress is not the asked socket');
    direct.offer(first, raw, raw.ws);
    assert.ok(direct.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'd1'), 'the same connection\'s first file is accepted');
    direct.offer({ t: P.T.FILE_OFFER, id: 'd2', name: 'PXL_2.jpg', size: 1, drop: 'send', batch: 'direct-1', count: 2 }, raw);
    assert.ok(direct.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'd2'), 'a later file of that batch is checked again and allowed');
    const replaced = { authed: true, deviceId: raw.deviceId, name: 'Pixel', os: P.OS.ANDROID, ws: sock('later') };
    direct.offer({ t: P.T.FILE_OFFER, id: 'd3', name: 'PXL_3.jpg', size: 1, drop: 'send', batch: 'direct-1', count: 2 }, replaced);
    assert.ok(refused(direct.sent, 'd3'), 'a replaced connection does not continue the batch');
    console.log('  direct: one batch on that connection; a later file is rechecked');
  } finally {
    direct.drop.clearAsked();
    fs.rmSync(direct.dir, { recursive: true, force: true });
  }

  // Guest mesh: the dialled socket is the session. The next dial is not.
  const guest = setup();
  const dial = { readyState: 1 };
  try {
    const first = guestView('pixel-1', dial);
    guest.server.current = first;
    guest.server.emit('client', first);
    guest.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['9'] } });
    guest.offer({ t: P.T.FILE_OFFER, id: 'g1', name: 'a.jpg', size: 1, drop: 'send', batch: 'guest-1', count: 1 }, guestView('pixel-1', dial));
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
  const phone = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: sock('sock') };
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

    const other = { authed: true, deviceId: 'other', name: 'Other', os: P.OS.ANDROID, ws: sock('other') };
    b.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['7'] } });
    b.offer({ t: P.T.FILE_OFFER, id: 'cross', name: 'x.jpg', size: 1, drop: 'send', batch: 'c', count: 1 }, mesh(other));
    const replaced = { authed: true, deviceId: phone.deviceId, name: 'Pixel', os: P.OS.ANDROID, ws: sock('next') };
    b.offer({ t: P.T.FILE_OFFER, id: 'replay', name: 'x.jpg', size: 1, drop: 'send', batch: 'r', count: 1 }, mesh(replaced));
    b.offer({ t: P.T.FILE_OFFER, id: 'point', name: 'x.jpg', size: 1, drop: 'point', x: 0, y: 0 }, mesh(phone));
    b.server.emit('closed', mesh(phone));
    b.offer({ t: P.T.FILE_OFFER, id: 'stopped', name: 'x.jpg', size: 1, drop: 'send', batch: 's', count: 1 }, mesh(phone));
    b.server.current = mesh(phone);
    b.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['7'] } });
    b.hub.forget(false);
    b.offer({ t: P.T.FILE_OFFER, id: 'forgot', name: 'x.jpg', size: 1, drop: 'send', batch: 'f', count: 1 }, mesh(phone));
    const lone = { authed: true, deviceId: 'pixel-1', os: P.OS.ANDROID, ws: sock('single') };
    b.drop.allowAsked(lone);
    b.offer({ t: P.T.FILE_OFFER, id: 'raw-next', name: 'x.jpg', size: 1, drop: 'send', batch: 'n', count: 1 }, { authed: true, deviceId: 'pixel-1', os: P.OS.ANDROID, ws: sock('later') });
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
    const ctx = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: sock('sock') };
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

  // Stop sets released, and close() moves the socket to CLOSING, before 'closed'. The grant
  // must refuse that socket immediately. The closed handler is not what makes it refuse.
  const stop = setup();
  const held = sock('held');
  const live = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: held };
  try {
    stop.server.current = live;
    stop.server.emit('client', live);
    stop.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['1'] } });
    live.released = true; // Stop. The socket is still OPEN. 'closed' has not fired.
    stop.offer({ t: P.T.FILE_OFFER, id: 'stop-released', name: 'x.jpg', size: 1, drop: 'send', batch: 'sr', count: 1 }, live);
    assert.ok(refused(stop.sent, 'stop-released'), 'a released ctx is refused while its socket is still open');
    assert.ok(!stop.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'stop-released'));
    live.released = false;
    stop.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['2'] } });
    held.readyState = 2; // CLOSING, before the closed event
    stop.offer({ t: P.T.FILE_OFFER, id: 'stop-closing', name: 'x.jpg', size: 1, drop: 'send', batch: 'sc', count: 1 }, live);
    assert.ok(refused(stop.sent, 'stop-closing'), 'a socket that has begun to close is refused before closed');
    held.readyState = 1;
    stop.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['3'] } });
    const swapped = sock('swapped');
    live.ws = swapped; // the ctx stayed; its socket was replaced. closed has not fired.
    stop.offer({ t: P.T.FILE_OFFER, id: 'stop-replaced', name: 'x.jpg', size: 1, drop: 'send', batch: 'sp', count: 1 }, live);
    assert.ok(refused(stop.sent, 'stop-replaced'), 'the same device id on a replaced socket is refused');
    console.log('  stop: released, closing and replaced sockets are refused before closed');
  } finally {
    stop.drop.clearAsked();
    fs.rmSync(stop.dir, { recursive: true, force: true });
  }

  // Real Mac mesh: Session → Hub → Route. The Save binds the guest socket send() uses while the
  // host ctx is also up. Offers carry the socket the callback was given, including a reconnect
  // that keeps the Link and replaces its ws. Not two viewOf() results built to share a conn.
  await meshOverlap();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function sockHolder() {
  return { readyState: 1 };
}

// The Mac mesh path the Save uses: a Hub, its Session, and the phone route. source is whatever
// the link callback or the server message passed, not the route's current outbound socket.
async function meshOverlap() {
  process.env.TWINDESK_NO_FX2 = '1';
  const { Hub } = require('../../mac/mesh/hub.js');
  const links = new EventEmitter();
  links.list = () => [];
  links.pairState = () => null;
  links.bindServer = () => {};
  const mesh = {
    addPeer() {}, removePeer() {}, handle() { return false; }, get() { return null; },
    rosterMessage() { return { t: 'mesh.roster' }; },
  };
  const hub = new Hub({ device: { id: 'mac', name: 'Mac' }, links, mesh, server: null, pairing: null });
  const guestWs = sock('guest');
  const link = new EventEmitter();
  link.authed = true;
  link.ws = guestWs;
  link.transport = 'ip';
  link.lastRx = 1;
  link.status = { state: 'connected', rtt: 1, message: '' };
  link.pairing = { macId: 'pixel-1', macName: 'Pixel', address: '10.0.0.9', os: P.OS.ANDROID };
  link.send = () => !!(link.ws && link.ws.readyState === 1);
  link.onState = () => {};
  links.emit('add', link);
  const session = hub.sessions.get('pixel-1');
  assert.ok(session, 'the link became a session');
  const hostWs = sock('host');
  const ctx = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, address: '10.0.0.8', ws: hostWs, released: false };
  session.setCtx(ctx);
  assert.strictEqual(session.outbound(), guestWs, 'send() uses the guest socket while the host ctx is also up');
  const route = hub.phoneRoute();
  const arrived = [];
  route.on(`t:${P.T.FILE_OFFER}`, (m, v) => arrived.push(v));
  const server = new EventEmitter();
  server.clients = new Map();
  server.port = 0;
  server.setPrimary = () => {};
  hub.attachHost(server, null);

  const box = setup();
  try {
    const current = route.current;
    assert.strictEqual(current.conn, guestWs);
    assert.strictEqual(current.ws, hostWs, 'other view fields still prefer the host ctx');
    assert.strictEqual(box.drop.allowAsked(current), true);
    const offer = (id, batch) => ({ t: P.T.FILE_OFFER, id, name: `${id}.jpg`, size: 1, drop: 'send', batch, count: 1 });

    server.emit('message', offer('from-host', 'host-batch'), ctx, hostWs);
    assert.strictEqual(arrived[0].source(), hostWs, 'the host offer is the socket the server callback passed');
    assert.notStrictEqual(arrived[0].source(), current.conn);
    box.offer(offer('from-host', 'host-batch'), arrived[0]);
    assert.ok(refused(box.sent, 'from-host'), 'an offer on the host socket is not the Save, which went out on the guest');

    link.onAny(offer('from-guest', 'guest-batch'), guestWs);
    assert.strictEqual(arrived[1].source(), guestWs, 'the guest offer is the socket the link callback passed');
    box.offer(offer('from-guest', 'guest-batch'), arrived[1]);
    assert.ok(box.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'from-guest'), 'the offer on the outbound guest socket is the one Save');

    // Same Link, new socket. The old callback's socket must not be read as link.ws now.
    const next = sock('rejoin');
    link.ws = next;
    link.onAny(offer('stale', 'stale-batch'), guestWs);
    assert.strictEqual(arrived[2].source(), null, 'the previous socket is not this Link anymore');
    box.drop.allowAsked(route.current);
    assert.strictEqual(route.current.conn, next, 'a new Save binds the socket send() uses after the reconnect');
    box.offer(offer('stale', 'stale-batch'), arrived[2]);
    assert.ok(refused(box.sent, 'stale'), 'a message from the old socket is not the new Save');
    link.onAny(offer('rejoined', 'rejoin-batch'), next);
    assert.strictEqual(arrived[3].source(), next);
    box.offer(offer('rejoined', 'rejoin-batch'), arrived[3]);
    assert.ok(box.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'rejoined'), 'the offer on the new socket is the new Save');

    // Stop before closed: the link is down and the host ctx is released, sockets still OPEN,
    // and neither side's callback is an ingress. The grant was the guest socket.
    box.drop.allowAsked(route.current);
    assert.strictEqual(route.current.conn, next);
    link.authed = false;
    ctx.released = true;
    server.emit('message', offer('after-stop', 'stop-batch'), ctx, hostWs);
    assert.strictEqual(arrived[4].conn, null, 'a released host ctx is not an ingress');
    link.onAny(offer('guest-stopped', 'stop-batch'), next);
    assert.strictEqual(arrived[5].conn, null, 'the guest socket is not live once the link is down');
    box.offer(offer('guest-stopped', 'stop-batch'), arrived[5]);
    assert.ok(refused(box.sent, 'guest-stopped'), 'Stop refuses the grant before the closed event');
    console.log('  mesh: overlap and a reconnect on the same Link follow the socket that was used');
  } finally {
    box.drop.clearAsked();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
}
