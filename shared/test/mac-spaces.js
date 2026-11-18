// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Previous/next macOS desktop on the display a viewer is being shown.
// Run with: node shared/test/mac-spaces.js
// The helper is a fake. This does not switch a desktop on this Mac.
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const S = require('../mac-spaces.js');
const { SpaceSwitch, SpaceLook, DesktopRefresh } = require('../../mac/space-switch.js');

const SEPARATE = {
  spans: false,
  composed: true,
  ax: true,
  displays: [
    { uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11', '12'] },
    { uuid: 'BBB', cgId: 2, current: '20', spaces: ['20', '21'] },
  ],
};

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(fn) {
  for (let i = 0; i < 40; i++) {
    if (fn()) return;
    await tick();
  }
  assert.fail('timed out');
}

// The fake models the helper's contract and does not touch Mission Control.
// spacesSwitch blocks until released, then resolves armed without pressing.
// spacesCommit presses on a later turn unless spacesAbort has already set cancelled.
// deferPress leaves that later turn in the test's hands. killOnCommit drops the
// session at the moment commit arrives, before that turn.
const NAMES = [
  { id: '1', name: 'Built-in Display', primary: true },
  { id: '2', name: 'Studio Display', primary: false },
];

function harness(look, { holdLook = false, already = false, deferPress = false, killOnCommit = false, names = null, offerDisplays = null } = {}) {
  const calls = [];
  const blocked = [];
  const replies = [];
  const presses = [];
  const actions = [];
  let alive = true;
  let input = true;
  let authed = true;
  let target = { id: 1 };
  let openLook = null;
  let session = null;
  let pressGate = null;
  const helper = {
    request(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'spacesLook') {
        const finish = () => (look instanceof Error ? Promise.reject(look) : Promise.resolve(look));
        if (!holdLook) return finish();
        return new Promise((resolve, reject) => {
          openLook = () => (look instanceof Error ? reject(look) : resolve(look));
        });
      }
      if (cmd === 'spacesAbort') {
        const before = !(session && session.pressed);
        if (session && args && args.token === session.token && !session.pressed) {
          session.cancelled = true;
          if (!session.settled) {
            session.settled = true;
            if (session.opened) actions.push('close');
            if (session.held) { actions.push('restore'); session.held = false; }
          }
          if (!session.armed && blocked.length) blocked.shift().reject(new Error('stale'));
        }
        return Promise.resolve({ aborted: !!(session && session.cancelled && before), beforePress: before && !(session && session.pressed) });
      }
      if (cmd === 'spacesSwitch') {
        if (already) return Promise.reject(new Error('overview'));
        session = { token: args.token, cancelled: false, pressed: false, armed: false, settled: false, held: true, opened: true };
        actions.push('hold', 'open');
        return new Promise((resolve, reject) => {
          blocked.push({
            args,
            resolve: () => {
              if (!session || session.cancelled) reject(new Error('stale'));
              else {
                session.armed = true;
                resolve({ phase: 'armed', token: args.token });
              }
            },
            reject,
          });
        });
      }
      if (cmd === 'spacesCommit') {
        if (killOnCommit) alive = false;
        return new Promise((resolve, reject) => {
          const run = () => {
            if (!session || session.cancelled || session.pressed || !args || args.token !== session.token) {
              reject(new Error('stale'));
              return;
            }
            session.pressed = true;
            session.settled = true;
            if (session.held) { actions.push('restore'); session.held = false; }
            actions.push('press');
            presses.push(args);
            resolve({ switched: true });
          };
          if (deferPress) { pressGate = run; return; }
          setImmediate(run);
        });
      }
      return Promise.reject(new Error('key'));
    },
  };
  let deliver;
  new SpaceSwitch({
    listen(fn) { deliver = fn; },
    helper,
    enabled: () => input,
    authorize: () => (authed ? () => alive : null),
    targetFor: () => target,
    reply: (_ctx, msg) => replies.push(msg),
    names: names || (() => []),
    offerDisplays: offerDisplays || (() => false),
  });
  return {
    calls, blocked, replies, presses, actions, deliver,
    get session() { return session; },
    get pressGate() { return pressGate; },
    releaseLook() { if (openLook) openLook(); },
    set alive(v) { alive = v; },
    set input(v) { input = v; },
    set authed(v) { authed = v; },
    set target(v) { target = v; },
    get target() { return target; },
  };
}

async function main() {
  // Planner: one display's next desktop, and the refusals that must not move anything.
  {
    const next = S.planSwitch(SEPARATE, { displayId: '1', dir: 1 });
    assert.deepStrictEqual(next, { ok: true, spaceId: '11', displayId: '1', index: 1, count: 3 });
    const prev = S.planSwitch({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '11', spaces: ['10', '11'] }],
    }, { displayId: '1', dir: -1 });
    assert.deepStrictEqual(prev, { ok: true, spaceId: '10', displayId: '1', index: 0, count: 2 });
    assert.deepStrictEqual(S.planSwitch(SEPARATE, { displayId: '1', dir: -1 }), { ok: false, why: 'edge', edge: 'first' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '12', spaces: ['10', '11', '12'] }],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'edge', edge: 'last' });

    // One display can move even when the spans-displays preference is on: nothing else exists.
    assert.strictEqual(S.planSwitch({
      spans: true,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] }],
    }, { displayId: '1', dir: 1 }).ok, true);

    assert.deepStrictEqual(S.planSwitch({ ...SEPARATE, spans: true }, { displayId: '1', dir: 1 }), { ok: false, why: 'spans' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [
        { uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] },
        { uuid: 'BBB', cgId: 2, current: '10', spaces: ['10', '21'] },
      ],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'spans' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [
        { uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] },
        { uuid: 'BBB', cgId: '', current: '20', spaces: ['20'] },
      ],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'unavailable' });
    assert.deepStrictEqual(S.planSwitch(SEPARATE, { displayId: '9', dir: 1 }), { ok: false, why: 'display' });
    assert.deepStrictEqual(S.planSwitch(SEPARATE, { displayId: '1', dir: 0 }), { ok: false, why: 'dir' });
    assert.deepStrictEqual(S.planSwitch({ spans: false, displays: [] }, { displayId: '1', dir: 1 }), { ok: false, why: 'unavailable' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      displays: [{ uuid: 'AAA', cgId: 1, current: '99', spaces: ['10', '11'] }],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'unavailable' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: '1', current: '10', spaces: ['10', '0', 'nope', '10', '11'] }],
    }, { displayId: '1', dir: 1 }), { ok: true, spaceId: '11', displayId: '1', index: 1, count: 2 });

    // Windows still visible from another desktop: no button, and no switch.
    const mixed = {
      spans: false,
      composed: false,
      displays: [
        { uuid: 'LEFT', cgId: 5, current: '9', spaces: ['7', '8', '9', '10', '11', '12'] },
        { uuid: 'RIGHT', cgId: 1, current: '15', spaces: ['236', '18', '14', '15', '17'] },
      ],
    };
    assert.deepStrictEqual(S.planSwitch(mixed, { displayId: '5', dir: 1 }), { ok: false, why: 'composed' });
    assert.strictEqual(S.offerSpaces(mixed, { id: 5 }), false);
    assert.strictEqual(S.offerSpaces({ ...SEPARATE, composed: false }, { id: 1 }), false);
    assert.strictEqual(S.offerSpaces(SEPARATE, { id: 1 }), true);
    assert.strictEqual(S.offerSpaces({ ...SEPARATE, ax: false }, { id: 1 }), false);
    const noAx = { ...SEPARATE };
    delete noAx.ax;
    assert.strictEqual(S.offerSpaces(noAx, { id: 1 }), false);
    assert.strictEqual(S.offerSpaces({ ...SEPARATE, inputHeld: true }, { id: 1 }), false);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1, generation: 1 }), S.viewToken({ id: 1, generation: 3 })), false);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1 }), S.viewToken({ id: 1 })), true);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1, generation: 1 }), S.viewToken({ id: 1 })), false);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1, generation: null }), S.viewToken({ id: 1, generation: null })), false);
    const slot = { key: null, generation: 0 };
    assert.strictEqual(S.noteGeneration(slot, 'default:1'), 1);
    assert.strictEqual(S.noteGeneration(slot, 'default:1'), 1);
    assert.strictEqual(S.noteGeneration(slot, 'default:2'), 2);
    assert.strictEqual(S.noteGeneration(slot, 'default:1'), 3);
    assert.strictEqual(S.noteGeneration(slot, 'none:1'), 4);
    assert.strictEqual(S.spaceHold({ inputHeld: true, holdWhy: 'overview' }), 'overview');
    assert.strictEqual(S.spaceHold({ inputHeld: true }), 'accessibility');
    assert.strictEqual(S.spaceHold({ inputHeld: false, holdWhy: 'overview' }), '');
    assert.strictEqual(S.offerSpaces(SEPARATE, { id: 2 }), true);
    assert.strictEqual(S.offerSpaces(SEPARATE, null), false);
    assert.strictEqual(S.offerSpaces({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '10', spaces: ['10'] }],
    }, { id: 1 }), false);
  }

  // The picture that is actually up. A missing or previous capture is not a target.
  {
    const want = { id: 2, label: 'LG' };
    const live = { viewer: true, waitingPolicy: false, sharing: true, activeId: 2, want };
    assert.strictEqual(S.viewedDisplay(live), want);
    assert.strictEqual(S.viewedDisplay({ ...live, viewer: null }), want);
    assert.strictEqual(S.viewedDisplay({ ...live, viewer: false }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, waitingPolicy: true }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, sharing: false }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, choiceMode: 'none' }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, activeId: 1 }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, activeId: null }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, want: null }), null);
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next' }), { ok: true, displayId: '2' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: '' }), { ok: true, displayId: '2' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: '2' }), { ok: true, displayId: '2' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: '1' }), { ok: false, why: 'display' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: 'side' }), { ok: false, why: 'display' });
    assert.deepStrictEqual(S.resolveTarget(null, { dir: 'next' }), { ok: false, why: 'target' });
    assert.deepStrictEqual(S.resolveTarget({ id: 0 }, { dir: 'next' }), { ok: false, why: 'target' });
    assert.strictEqual(S.dirOf({ dir: 'prev' }), -1);
    assert.strictEqual(S.dirOf({ dir: 'next' }), 1);
    assert.strictEqual(S.dirOf({ dir: 'left' }), 0);
  }

  // One-to-one and mesh session gates. A later check fails once the socket is no longer that session.
  {
    const ws = { readyState: 1 };
    const ctx = { authed: true, ws, deviceId: 'phone' };
    const current = { authed: true, ws, deviceId: 'phone' };
    let read = current;
    const still = S.streamInputGate(ctx, () => read);
    assert.strictEqual(typeof still, 'function');
    assert.strictEqual(still(), true);
    ctx.released = true;
    assert.strictEqual(still(), false);
    ctx.released = false;
    ws.readyState = 2;
    assert.strictEqual(still(), false);
    ws.readyState = 1;
    read = { authed: true, ws: {}, deviceId: 'phone' };
    assert.strictEqual(still(), false);
    assert.strictEqual(S.streamInputGate({ ...ctx, authed: false }, () => current), null);
    assert.strictEqual(S.streamInputGate(ctx, () => null), null);
    assert.strictEqual(S.streamInputGate(ctx, () => ({ authed: true, ws, deviceId: 'other' })), null);

    const link = { authed: true, ws: { readyState: 1 } };
    const hostWs = { readyState: 1 };
    const host = { authed: true, ws: hostWs };
    let session = { connected: true, linkUp: true, link, hostUp: false, ctx: null };
    const meshStill = S.meshGate(() => session, link);
    assert.strictEqual(meshStill(), true);
    link.ws.readyState = 2;
    assert.strictEqual(meshStill(), false);
    link.ws.readyState = 1;
    session = { ...session, link: { authed: true, ws: { readyState: 1 } } };
    assert.strictEqual(meshStill(), false);
    session = { connected: true, linkUp: false, hostUp: true, ctx: host };
    const hostStill = S.meshGate(() => session, host);
    assert.strictEqual(hostStill(), true);
    session = { ...session, ctx: { authed: true, ws: { readyState: 1 } } };
    assert.strictEqual(hostStill(), false);
    session = { connected: true, linkUp: true, link, hostUp: true, ctx: host };
    assert.strictEqual(hostStill(), false);
    assert.strictEqual(S.meshGate(() => session, host), null);
    const guestStill = S.meshGate(() => session, link);
    assert.strictEqual(guestStill(), true);
    const originalGuestWs = link.ws;
    link.ws = { readyState: 1 };
    assert.strictEqual(guestStill(), false, 'a reconnect on the same Link invalidates the old gate');
    link.ws = originalGuestWs;
    const releasedHost = { authed: true, released: true, ws: { readyState: 1 } };
    session = { connected: true, linkUp: true, link, hostUp: true, ctx: releasedHost };
    assert.strictEqual(S.meshGate(() => session, releasedHost), null);
    assert.strictEqual(S.meshGate(() => session), null);
    assert.strictEqual(guestStill(), true);
    link.released = true;
    assert.strictEqual(guestStill(), false);
    link.released = false;
    assert.strictEqual(S.meshGate(() => ({ connected: false }), link), null);
    assert.strictEqual(S.meshGate(() => ({ connected: true, linkUp: true, link: { authed: false, ws: { readyState: 1 } } }), link), null);
    assert.strictEqual(S.meshGate(() => ({ connected: true, linkUp: false, hostUp: true, ctx: { authed: true, ws: { readyState: 1 } } })), null);
  }

  // Main path: arm names the viewed display and the exact next index. The press is the commit, after the arm.
  {
    const h = harness(SEPARATE);
    h.deliver({ t: 'screen.space', dir: 'next', displayId: '1' }, { id: 'phone' });
    await until(() => h.blocked.length === 1);
    assert.deepStrictEqual(h.calls.map((c) => c.cmd), ['spacesLook', 'spacesSwitch']);
    assert.deepStrictEqual(h.calls[1].args, { displayId: 1, spaceId: '11', index: 1, count: 3, token: '1' });
    assert.strictEqual(h.presses.length, 0);
    assert.deepStrictEqual(h.actions, ['hold', 'open']);
    h.blocked[0].resolve();
    await until(() => h.replies.length === 1);
    assert.deepStrictEqual(h.replies[0], { t: P.T.SCREEN_SPACE_RESULT, ok: true, dir: 'next' });
    assert.strictEqual(h.presses.length, 1);
    assert.strictEqual(h.presses[0].token, '1');
    assert.deepStrictEqual(h.actions, ['hold', 'open', 'restore', 'press']);
    assert.ok(!h.actions.includes('close'));
  }

  // Unauthorized, stale, input off, the wrong display, and a shared-desktop snapshot do not switch.
  {
    const refused = async (setup, msg, why) => {
      const h = harness(SEPARATE);
      setup(h);
      h.deliver(msg, { id: 'phone' });
      await until(() => h.replies.length === 1);
      assert.strictEqual(h.replies[0].ok, false, why);
      assert.strictEqual(h.replies[0].why, why);
      assert.ok(!h.calls.some((c) => c.cmd === 'spacesSwitch'), why);
      return h;
    };
    const none = await refused((h) => { h.authed = false; h.input = false; }, { dir: 'next' }, 'unauthorized');
    assert.strictEqual(none.calls.length, 0);
    const early = await refused((h) => { h.alive = false; }, { dir: 'next' }, 'stale');
    assert.strictEqual(early.calls.length, 0);
    const off = await refused((h) => { h.input = false; }, { dir: 'next' }, 'input');
    assert.strictEqual(off.calls.length, 0);
    const mismatch = await refused(() => {}, { dir: 'next', displayId: '2' }, 'display');
    assert.strictEqual(mismatch.calls.length, 0);
    const badDir = await refused(() => {}, { dir: 'left' }, 'dir');
    assert.strictEqual(badDir.calls.length, 0);
    const gone = await refused((h) => { h.target = null; }, { dir: 'next' }, 'target');
    assert.strictEqual(gone.calls.length, 0);

    const stale = harness(SEPARATE, { holdLook: true });
    stale.deliver({ dir: 'next', displayId: '1' }, {});
    await until(() => stale.calls.some((c) => c.cmd === 'spacesLook'));
    stale.alive = false;
    stale.releaseLook();
    await until(() => stale.replies.length === 1);
    assert.strictEqual(stale.replies[0].why, 'stale');
    assert.ok(!stale.calls.some((c) => c.cmd === 'spacesSwitch'));

    // Queued requests remain bound to the session that sent them, even if that device reconnects.
    {
      const link = { authed: true, ws: { readyState: 1 } };
      let session = { connected: true, linkUp: true, link, hostUp: false, ctx: null };
      let deliver, release;
      const calls = [], replies = [];
      new SpaceSwitch({
        listen(fn) { deliver = fn; },
        authorize: (ctx) => S.meshGate(() => session, ctx && ctx.source),
        enabled: () => true,
        targetFor: () => ({ id: 1 }),
        reply: (_ctx, msg) => replies.push(msg),
        helper: { request(cmd) { calls.push(cmd); return new Promise((resolve) => { release = () => resolve(SEPARATE); }); } },
      });
      deliver({ dir: 'next' }, { id: 'phone', source: link });
      deliver({ dir: 'next' }, { id: 'phone', source: link });
      await until(() => calls.length === 1);
      session = { connected: true, linkUp: true, link: { authed: true, ws: { readyState: 1 } } };
      release();
      await until(() => replies.length === 2);
      assert.deepStrictEqual(calls, ['spacesLook']);
      assert.ok(replies.every((r) => r.why === 'stale'));
    }

    const moved = harness(SEPARATE, { holdLook: true });
    moved.deliver({ dir: 'next', displayId: '1' }, {});
    await until(() => moved.calls.some((c) => c.cmd === 'spacesLook'));
    moved.target = { id: 2 };
    moved.releaseLook();
    await until(() => moved.replies.length === 1);
    assert.strictEqual(moved.replies[0].why, 'display');
    assert.ok(!moved.calls.some((c) => c.cmd === 'spacesSwitch'));

    const spans = harness({ ...SEPARATE, spans: true });
    spans.deliver({ dir: 'next' }, {});
    await until(() => spans.replies.length === 1);
    assert.strictEqual(spans.replies[0].why, 'spans');
    assert.deepStrictEqual(spans.calls.map((c) => c.cmd), ['spacesLook']);

    const mixed = harness({ ...SEPARATE, composed: false });
    mixed.deliver({ dir: 'next' }, {});
    await until(() => mixed.replies.length === 1);
    assert.strictEqual(mixed.replies[0].why, 'composed');
    assert.deepStrictEqual(mixed.calls.map((c) => c.cmd), ['spacesLook']);

    const edge = harness({
      spans: false,
      composed: true,
      ax: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] }],
    });
    edge.deliver({ dir: 'prev' }, {});
    await until(() => edge.replies.length === 1);
    assert.deepStrictEqual(edge.replies[0], { t: P.T.SCREEN_SPACE_RESULT, ok: false, why: 'edge', edge: 'first', dir: 'prev' });
    assert.ok(!edge.calls.some((c) => c.cmd === 'spacesSwitch'));
  }

  // Helper errors stay inside the why set. A thrown look never reaches a switch.
  {
    const missing = harness(new Error('unavailable'));
    missing.deliver({ dir: 'next' }, {});
    await until(() => missing.replies.length === 1);
    assert.strictEqual(missing.replies[0].why, 'unavailable');
    assert.deepStrictEqual(missing.calls.map((c) => c.cmd), ['spacesLook']);

    for (const [message, why] of [['shared', 'spans'], ['display', 'display'], ['nope', 'unavailable'], ['overview', 'overview'], ['ambiguous', 'ambiguous'], ['stale', 'stale']]) {
      const h = harness(SEPARATE);
      h.deliver({ dir: 'next' }, {});
      await until(() => h.blocked.length === 1);
      h.blocked[0].reject(new Error(message));
      await until(() => h.replies.length === 1);
      assert.strictEqual(h.replies[0].why, why, message);
      assert.deepStrictEqual(h.calls.map((c) => c.cmd), ['spacesLook', 'spacesSwitch', 'spacesAbort']);
      assert.strictEqual(h.presses.length, 0, message);
    }
  }

  // Mission Control already open: the helper refuses. We do not commit or press.
  {
    const open = harness(SEPARATE, { already: true });
    open.deliver({ dir: 'next' }, {});
    await until(() => open.replies.length === 1);
    assert.strictEqual(open.replies[0].why, 'overview');
    assert.deepStrictEqual(open.calls.map((c) => c.cmd), ['spacesLook', 'spacesSwitch', 'spacesAbort']);
    assert.deepStrictEqual(open.actions, []);
    assert.strictEqual(open.presses.length, 0);
  }

  // The session dies while the helper is still arming. Abort is acknowledged before any press.
  {
    const h = harness(SEPARATE);
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    h.alive = false;
    await until(() => h.calls.some((c) => c.cmd === 'spacesAbort'));
    await until(() => h.replies.length === 1);
    assert.strictEqual(h.replies[0].why, 'stale');
    assert.ok(!h.calls.some((c) => c.cmd === 'spacesCommit'));
    assert.strictEqual(h.presses.length, 0);
    assert.strictEqual(h.session.cancelled, true);
    assert.ok(h.actions.indexOf('close') > h.actions.indexOf('open'));
    assert.strictEqual(h.actions[h.actions.length - 1], 'restore');
    assert.ok(!h.actions.includes('press'));
  }

  // Replaced mesh session while the overview is arming: the abort command reaches the helper.
  {
    const link = { authed: true, ws: { readyState: 1 } };
    let session = { connected: true, linkUp: true, link, hostUp: false, ctx: null };
    let deliver;
    const calls = [];
    const replies = [];
    let blocked = null;
    let cancelled = false;
    let pressed = false;
    new SpaceSwitch({
      listen(fn) { deliver = fn; },
      authorize: (ctx) => S.meshGate(() => session, ctx && ctx.source),
      enabled: () => true,
      targetFor: () => ({ id: 1 }),
      reply: (_ctx, msg) => replies.push(msg),
      helper: {
        request(cmd, args) {
          calls.push(cmd);
          if (cmd === 'spacesLook') return Promise.resolve(SEPARATE);
          if (cmd === 'spacesAbort') {
            cancelled = true;
            if (blocked) blocked.reject(new Error('stale'));
            return Promise.resolve({ aborted: true, beforePress: !pressed });
          }
          if (cmd === 'spacesSwitch') {
            return new Promise((resolve, reject) => { blocked = { resolve, reject }; });
          }
          if (cmd === 'spacesCommit') {
            pressed = !cancelled;
            return cancelled ? Promise.reject(new Error('stale')) : Promise.resolve({ switched: true });
          }
          return Promise.reject(new Error('key'));
        },
      },
    });
    deliver({ dir: 'next' }, { id: 'phone', source: link });
    await until(() => calls.includes('spacesSwitch'));
    session = { connected: true, linkUp: true, link: { authed: true, ws: { readyState: 1 } }, hostUp: false, ctx: null };
    await until(() => calls.includes('spacesAbort') && cancelled);
    assert.strictEqual(pressed, false);
    await until(() => replies.length === 1);
    assert.strictEqual(replies[0].why, 'stale');
    assert.ok(!calls.includes('spacesCommit'));
  }

  // Commit has reached the helper and the session is replaced before the deferred press.
  // Abort is applied to the helper before that press is allowed to run.
  {
    const h = harness(SEPARATE, { deferPress: true, killOnCommit: true });
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    h.blocked[0].resolve();
    await until(() => h.calls.some((c) => c.cmd === 'spacesCommit'));
    await until(() => h.calls.some((c) => c.cmd === 'spacesAbort') && h.session.cancelled);
    assert.strictEqual(h.presses.length, 0);
    assert.strictEqual(typeof h.pressGate, 'function');
    h.pressGate();
    await until(() => h.replies.length === 1);
    assert.strictEqual(h.replies[0].why, 'stale');
    assert.strictEqual(h.presses.length, 0);
    assert.ok(!h.actions.includes('press'));
    assert.ok(h.actions.includes('restore'));
  }

  // Two requests stay in order. The second look runs only after the first switch settles.
  {
    const h = harness({
      spans: false,
      composed: true,
      ax: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '11', spaces: ['10', '11', '12'] }],
    });
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    h.deliver({ dir: 'prev' }, {});
    await tick();
    assert.strictEqual(h.calls.length, 2);
    h.blocked[0].resolve();
    await until(() => h.blocked.length === 2);
    assert.strictEqual(h.calls[4].args.spaceId, '10');
    assert.strictEqual(h.calls[4].args.index, 0);
    assert.strictEqual(h.calls[4].args.count, 3);
    h.blocked[1].resolve();
    await until(() => h.replies.length === 2);
    assert.deepStrictEqual(h.replies.map((m) => m.dir), ['next', 'prev']);
    assert.ok(h.replies.every((m) => m.ok === true && m.t === 'screen.space.result'));
  }

  // Two Next actions queued on display 1. The first lookup is held, then the viewer
  // target becomes display 2. The second action was aimed at 1 and must not switch 2.
  {
    const h = harness(SEPARATE, { holdLook: true });
    h.target = { id: 1, generation: 1 };
    h.deliver({ dir: 'next' }, {});
    h.deliver({ dir: 'next' }, {});
    await until(() => h.calls.filter((c) => c.cmd === 'spacesLook').length === 1);
    assert.strictEqual(h.calls.length, 1);
    h.target = { id: 2, generation: 2 };
    h.releaseLook();
    await until(() => h.replies.length === 2);
    assert.ok(h.replies.every((r) => r.ok === false && r.why === 'display'));
    assert.ok(!h.calls.some((c) => c.cmd === 'spacesSwitch'));
    assert.ok(!h.calls.some((c) => c.args && c.args.displayId === 2));
  }

  // A→B→A while the first lookup is held. The id is 1 again, but the generation moved.
  {
    const h = harness(SEPARATE, { holdLook: true });
    h.target = { id: 1, generation: 1 };
    h.deliver({ dir: 'next' }, {});
    h.deliver({ dir: 'next' }, {});
    await until(() => h.calls.filter((c) => c.cmd === 'spacesLook').length === 1);
    h.target = { id: 2, generation: 2 };
    h.target = { id: 1, generation: 3 };
    h.releaseLook();
    await until(() => h.replies.length === 2);
    assert.ok(h.replies.every((r) => r.ok === false && r.why === 'display'));
    assert.ok(!h.calls.some((c) => c.cmd === 'spacesSwitch'));
  }

  // The same id and the same generation still switches that display.
  {
    const h = harness(SEPARATE);
    h.target = { id: 1, generation: 4 };
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    assert.strictEqual(h.calls[1].args.displayId, 1);
    assert.strictEqual(h.calls[1].args.spaceId, '11');
    h.blocked[0].resolve();
    await until(() => h.replies.length === 1);
    assert.strictEqual(h.replies[0].ok, true);
  }

  // Accessibility is not trusted, or input is already paused: do not open Mission Control.
  {
    const untrusted = harness({ ...SEPARATE, ax: false });
    untrusted.deliver({ dir: 'next' }, {});
    await until(() => untrusted.replies.length === 1);
    assert.strictEqual(untrusted.replies[0].why, 'accessibility');
    assert.ok(!untrusted.calls.some((c) => c.cmd === 'spacesSwitch'));

    const bareLook = { ...SEPARATE };
    delete bareLook.ax;
    const bare = harness(bareLook);
    bare.deliver({ dir: 'next' }, {});
    await until(() => bare.replies.length === 1);
    assert.strictEqual(bare.replies[0].why, 'accessibility');
    assert.ok(!bare.calls.some((c) => c.cmd === 'spacesSwitch'));

    const held = harness({ ...SEPARATE, inputHeld: true, holdWhy: 'overview' });
    held.deliver({ dir: 'next' }, {});
    await until(() => held.replies.length === 1);
    assert.strictEqual(held.replies[0].why, 'overview');
    assert.ok(!held.calls.some((c) => c.cmd === 'spacesSwitch'));

    const unknownHold = harness({ ...SEPARATE, inputHeld: true });
    unknownHold.deliver({ dir: 'next' }, {});
    await until(() => unknownHold.replies.length === 1);
    assert.strictEqual(unknownHold.replies[0].why, 'accessibility');
    assert.ok(!unknownHold.calls.some((c) => c.cmd === 'spacesSwitch'));
  }

  // Absolute choice: one desktop from a bounded catalog. Previous/next above is unchanged.
  {
    assert.strictEqual(S.absoluteRequest({ dir: 'next' }), null);
    assert.strictEqual(S.absoluteRequest({ dir: 'next', displayId: '1' }), null);
    assert.deepStrictEqual(
      S.absoluteRequest({ displayId: '1', spaceId: '11', index: 1, count: 3, rev: 5 }),
      { spaceId: '11', index: 1, count: 3, rev: 5, displayId: '1' },
    );
    assert.deepStrictEqual(
      S.absoluteRequest({ dir: 'next', displayId: '1', spaceId: '11', index: 1, count: 3, rev: 5 }),
      { error: 'space' },
    );
    assert.deepStrictEqual(S.absoluteRequest({ spaceId: '11', index: 1, count: 3, rev: 5 }), { error: 'display' });
    assert.deepStrictEqual(
      S.absoluteRequest({ displayId: 'nope', spaceId: '11', index: 1, count: 3, rev: 5 }),
      { error: 'display' },
    );
    assert.deepStrictEqual(
      S.absoluteRequest({ displayId: '1', spaceId: '0', index: 1, count: 3, rev: 5 }),
      { error: 'space' },
    );

    const viewed = { id: 1, generation: 4 };
    const cat = S.desktopCatalog(SEPARATE, viewed, NAMES, { offerDisplays: true });
    assert.ok(cat);
    assert.strictEqual(cat.viewing, '1');
    assert.strictEqual(cat.viewGen, 4);
    assert.deepStrictEqual(cat.displays.map((d) => d.id), ['1', '2']);
    assert.ok(!JSON.stringify(cat).includes('uuid'));
    assert.ok(!JSON.stringify(cat).includes('AAA'));
    assert.ok(!Object.prototype.hasOwnProperty.call(cat, 'windows'));
    const renamed = S.desktopCatalog(SEPARATE, viewed, NAMES.map((n) => ({ ...n, name: 'Other' })), { offerDisplays: true });
    assert.strictEqual(renamed.rev, cat.rev);
    assert.notStrictEqual(renamed.displays[0].name, cat.displays[0].name);
    const movedGen = S.desktopCatalog(SEPARATE, { id: 1, generation: 5 }, NAMES, { offerDisplays: true });
    assert.notStrictEqual(movedGen.rev, cat.rev);

    const choose = {
      displayId: '1', spaceId: '11', index: 1, count: 3, rev: cat.rev, viewed, named: NAMES, offerDisplays: true,
    };
    assert.deepStrictEqual(S.planSelect(SEPARATE, choose), { ok: true, spaceId: '11', displayId: '1', index: 1, count: 3 });
    assert.deepStrictEqual(S.planSelect(SEPARATE, { ...choose, index: 0 }), { ok: false, why: 'stale' });
    assert.deepStrictEqual(S.planSelect(SEPARATE, { ...choose, count: 2 }), { ok: false, why: 'stale' });
    assert.deepStrictEqual(S.planSelect(SEPARATE, { ...choose, rev: (cat.rev + 1) >>> 0 }), { ok: false, why: 'stale' });
    assert.deepStrictEqual(S.planSelect(SEPARATE, { ...choose, viewed: { id: 1, generation: 5 } }), { ok: false, why: 'stale' });

    const here = { ...choose, spaceId: '10', index: 0 };
    assert.deepStrictEqual(S.planSelect({ ...SEPARATE, composed: false }, here), {
      ok: true, already: true, spaceId: '10', displayId: '1', index: 0, count: 3,
    });
    assert.deepStrictEqual(S.planSelect({ ...SEPARATE, spans: true }, here), {
      ok: true, already: true, spaceId: '10', displayId: '1', index: 0, count: 3,
    });
    assert.deepStrictEqual(S.planSelect({ ...SEPARATE, composed: false }, choose), { ok: false, why: 'composed' });
    assert.deepStrictEqual(S.planSelect({ ...SEPARATE, spans: true }, choose), { ok: false, why: 'spans' });

    const meshView = { id: 1, generation: 4 };
    const meshCat = S.desktopCatalog(SEPARATE, meshView, NAMES, { offerDisplays: false });
    assert.deepStrictEqual(meshCat.displays.map((d) => d.id), ['1']);
    assert.strictEqual(S.planSelect(SEPARATE, {
      displayId: '2', spaceId: '21', index: 1, count: 2, rev: meshCat.rev,
      viewed: meshView, named: NAMES, offerDisplays: false,
    }).why, 'display');
    const forged = S.desktopCatalog(SEPARATE, { id: 2, generation: 4 }, NAMES, { offerDisplays: true });
    assert.strictEqual(S.planSelect(SEPARATE, {
      displayId: '2', spaceId: '21', index: 1, count: 2, rev: forged.rev,
      viewed: { id: 2, generation: 4 }, named: NAMES, offerDisplays: false,
    }).why, 'stale');

    const many = [];
    for (let i = 1; i <= 70; i++) many.push(String(i));
    const longLook = {
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '1', spaces: many }],
    };
    const longCat = S.desktopCatalog(longLook, { id: 1 }, [{ id: '1', name: 'A\u0000\u202eBuilt-in', primary: true }], { offerDisplays: true });
    assert.strictEqual(longCat.displays[0].spaces.length, 64);
    assert.strictEqual(longCat.displays[0].count, 70);
    assert.strictEqual(longCat.displays[0].truncated, true);
    assert.strictEqual(longCat.displays[0].name, 'A Built-in');
    assert.ok(!JSON.stringify(longCat).includes('uuid'));

    const nine = [];
    const nineNames = [];
    for (let i = 1; i <= 9; i++) {
      nine.push({ uuid: 'U' + i, cgId: i, current: String(i * 10), spaces: [String(i * 10), String(i * 10 + 1)] });
      nineNames.push({ id: String(i), name: 'Display ' + i, primary: i === 1 });
    }
    const nineCat = S.desktopCatalog({ composed: true, spans: false, displays: nine }, { id: 1 }, nineNames, { offerDisplays: true });
    assert.strictEqual(nineCat.displays.length, 8);
    assert.ok(!nineCat.displays.some((d) => d.id === '9'));

    const full = [];
    const fullNames = [];
    for (let i = 1; i <= 8; i++) {
      full.push({ uuid: 'U' + i, cgId: i, current: String(100 + i), spaces: [String(100 + i), String(200 + i)] });
      fullNames.push({ id: String(i), name: 'Display ' + i, primary: i === 1 });
    }
    full.push({ uuid: 'VVV', cgId: 99, current: '30', spaces: ['30', '31'] });
    const extendCat = S.desktopCatalog({ composed: true, spans: false, displays: full }, { id: 99, generation: 2 }, fullNames, { offerDisplays: true });
    assert.strictEqual(extendCat.displays.length, 8);
    assert.strictEqual(extendCat.displays[7].id, '99');
    assert.strictEqual(extendCat.viewing, '99');
    assert.ok(!extendCat.displays.some((d) => d.id === '8'));

    const screens = [
      { id: 1, name: 'Built-in', primary: true },
      { id: 2, label: 'Studio', primary: false },
      { id: 3, name: 'Virtual', virtual: true },
    ];
    assert.strictEqual(S.catalogOffer(screens, { remote: true }).offerDisplays, true);
    assert.strictEqual(S.catalogOffer(screens, { remote: true }).named.some((d) => d.id === '3'), false);
    assert.strictEqual(S.catalogOffer(screens, { mesh: true, remote: true }).offerDisplays, false);
    assert.strictEqual(S.catalogOffer(screens, { remote: true, held: true }).offerDisplays, false);
    assert.strictEqual(S.catalogOffer(screens, { remote: false }).offerDisplays, false);
    assert.strictEqual(S.catalogOffer([], { remote: true }).offerDisplays, false);
  }

  // The helper is asked for that exact desktop. A stale revision, a dead session, or another
  // display never reaches spacesSwitch. Already current does not open Mission Control.
  {
    const viewed = { id: 1, generation: 7, session: 42 };
    const cat = S.desktopCatalog(SEPARATE, viewed, NAMES, { offerDisplays: true });
    assert.strictEqual(cat.capture, 42);
    const msg = { displayId: '1', spaceId: '11', index: 1, count: 3, rev: cat.rev };
    const open = { names: () => NAMES, offerDisplays: () => true };
    const h = harness(SEPARATE, open);
    h.target = viewed;
    h.deliver(msg, { id: 'phone' });
    await until(() => h.blocked.length === 1);
    assert.deepStrictEqual(h.calls[1].args, { displayId: 1, spaceId: '11', index: 1, count: 3, token: '1' });
    h.blocked[0].resolve();
    await until(() => h.replies.length === 1);
    assert.deepStrictEqual(h.replies[0], { t: P.T.SCREEN_SPACE_RESULT, ok: true });
    assert.strictEqual(h.replies[0].dir, undefined);
    assert.strictEqual(h.presses.length, 1);

    const stale = harness(SEPARATE, open);
    stale.target = viewed;
    stale.deliver({ ...msg, rev: (cat.rev + 1) >>> 0 }, {});
    await until(() => stale.replies.length === 1);
    assert.strictEqual(stale.replies[0].why, 'stale');
    assert.ok(!stale.calls.some((c) => c.cmd === 'spacesSwitch'));

    const died = harness(SEPARATE, open);
    died.target = viewed;
    died.deliver(msg, {});
    await until(() => died.blocked.length === 1);
    died.alive = false;
    await until(() => died.calls.some((c) => c.cmd === 'spacesAbort'));
    await until(() => died.replies.length === 1);
    assert.strictEqual(died.replies[0].why, 'stale');
    assert.ok(!died.calls.some((c) => c.cmd === 'spacesCommit'));
    assert.strictEqual(died.presses.length, 0);

    const other = harness(SEPARATE, open);
    other.target = viewed;
    other.deliver({ displayId: '2', spaceId: '21', index: 1, count: 2, rev: cat.rev }, {});
    await until(() => other.replies.length === 1);
    assert.strictEqual(other.replies[0].why, 'display');
    assert.strictEqual(other.calls.length, 0);
    assert.ok(!other.calls.some((c) => c.args && c.args.displayId === 2));

    const mixed = harness(SEPARATE, open);
    mixed.deliver({ ...msg, dir: 'next' }, {});
    await until(() => mixed.replies.length === 1);
    assert.strictEqual(mixed.replies[0].why, 'space');
    assert.strictEqual(mixed.calls.length, 0);

    const here = S.desktopCatalog({ ...SEPARATE, composed: false, spans: true }, { id: 1 }, NAMES, { offerDisplays: true });
    const staying = harness({ ...SEPARATE, composed: false, spans: true }, open);
    staying.deliver({ displayId: '1', spaceId: '10', index: 0, count: 3, rev: here.rev }, {});
    await until(() => staying.replies.length === 1);
    assert.deepStrictEqual(staying.replies[0], { t: P.T.SCREEN_SPACE_RESULT, ok: true, already: true });
    assert.ok(!staying.calls.some((c) => c.cmd === 'spacesSwitch'));

    const meshRev = S.desktopCatalog(SEPARATE, { id: 1 }, NAMES, { offerDisplays: false });
    const mesh = harness(SEPARATE, { names: () => NAMES, offerDisplays: () => false });
    mesh.deliver({ displayId: '1', spaceId: '11', index: 1, count: 3, rev: meshRev.rev }, {});
    await until(() => mesh.blocked.length === 1);
    assert.strictEqual(mesh.calls[1].args.displayId, 1);
    assert.strictEqual(mesh.calls[1].args.spaceId, '11');
    mesh.blocked[0].resolve();
    await until(() => mesh.replies.length === 1);
    assert.strictEqual(mesh.replies[0].ok, true);

    const forged = S.desktopCatalog(SEPARATE, { id: 2 }, NAMES, { offerDisplays: true });
    const closed = harness(SEPARATE, { names: () => NAMES, offerDisplays: () => false });
    closed.target = { id: 2 };
    closed.deliver({ displayId: '2', spaceId: '21', index: 1, count: 2, rev: forged.rev }, {});
    await until(() => closed.replies.length === 1);
    assert.strictEqual(closed.replies[0].why, 'stale');
    assert.ok(!closed.calls.some((c) => c.cmd === 'spacesSwitch'));

    const aside = harness(SEPARATE, { names: () => NAMES, offerDisplays: () => false });
    aside.deliver({ displayId: '2', spaceId: '21', index: 1, count: 2, rev: forged.rev }, {});
    await until(() => aside.replies.length === 1);
    assert.strictEqual(aside.replies[0].why, 'display');
    assert.ok(!aside.calls.some((c) => c.args && c.args.displayId === 2));
  }

  assert.strictEqual(P.T.SCREEN_SPACE, 'screen.space');
  assert.strictEqual(P.T.SCREEN_SPACE_RESULT, 'screen.space.result');
  assert.strictEqual(P.T.SCREEN_DESKTOPS, 'screen.desktops');

  // A catalog read is published only for the view it started on. The helper is still a fake.
  assert.strictEqual(S.fenceView(null, null), true);
  assert.strictEqual(S.fenceView({ displayId: '1', generation: 2 }, { displayId: '1', generation: 2 }), true);
  assert.strictEqual(S.fenceView({ displayId: '1', generation: 2 }, { displayId: '1', generation: 3 }), false);
  assert.strictEqual(S.fenceView(null, { displayId: '1', generation: 2 }), false);
  assert.strictEqual(S.fenceView({ displayId: '1', generation: 2 }, null), false);
  assert.strictEqual(S.fenceView(undefined, null), false);
  assert.strictEqual(S.fenceView({ displayId: '1', generation: 2 }, undefined), false);

  const withSession = S.desktopCatalog(SEPARATE, { id: 1, generation: 4, session: 6 }, NAMES, { offerDisplays: true });
  assert.strictEqual(withSession.capture, 6);
  const otherSession = S.desktopCatalog(SEPARATE, { id: 1, generation: 4, session: 7 }, NAMES, { offerDisplays: true });
  assert.notStrictEqual(otherSession.rev, withSession.rev);
  const noSession = S.desktopCatalog(SEPARATE, { id: 1, generation: 4, session: 0 }, NAMES, { offerDisplays: true });
  assert.ok(!Object.prototype.hasOwnProperty.call(noSession, 'capture'));

  function heldHelper() {
    const calls = [];
    const pending = [];
    return {
      calls,
      request(cmd, args) {
        calls.push({ cmd, args });
        return new Promise((resolve) => pending.push(resolve));
      },
      release(look) {
        const done = pending.shift();
        assert.ok(done);
        done(look);
      },
    };
  }

  {
    const helper = heldHelper();
    let changes = 0;
    const look = new SpaceLook(helper, () => { changes += 1; });
    let generation = 1;
    let stale = 0;
    let fresh = 0;
    look.refresh({
      force: true,
      view: () => ({ displayId: '1', generation }),
      onStale: () => { stale += 1; },
      onFresh: () => { fresh += 1; },
    });
    assert.strictEqual(helper.calls.length, 1);
    look.refresh({ view: () => ({ displayId: '1', generation }) });
    assert.strictEqual(helper.calls.length, 1);
    generation = 2;
    helper.release(SEPARATE);
    await until(() => stale === 1);
    assert.strictEqual(look.current(), null);
    assert.strictEqual(fresh, 0);
    assert.strictEqual(changes, 0);
    assert.strictEqual(helper.calls.length, 1);
  }

  {
    const helper = heldHelper();
    const look = new SpaceLook(helper, () => {});
    const view = () => ({ displayId: '1', generation: 4 });
    look.refresh({ force: true, view });
    helper.release(SEPARATE);
    await until(() => look.current() === SEPARATE);
    const asked = helper.calls.length;
    look.refresh({ view });
    assert.strictEqual(helper.calls.length, asked);
    look.refresh({ force: true, view });
    assert.strictEqual(helper.calls.length, asked + 1);
    helper.release(SEPARATE);
    await until(() => helper.calls.length === asked + 1 && look.current() === SEPARATE);
  }

  {
    const helper = heldHelper();
    let alive = false;
    let generation = 4;
    const replies = [];
    let changes = 0;
    const spaceLook = new SpaceLook(helper, () => { changes += 1; });
    let handler = null;
    new DesktopRefresh({
      listen: (fn) => { handler = fn; },
      authorize: () => (alive ? () => alive : null),
      viewFor: () => ({ displayId: '1', generation, session: 6 }),
      spaceLook,
      reply: (_ctx, msg) => replies.push(msg),
    });
    handler({ epoch: 3 }, { id: 'phone' });
    await tick();
    assert.strictEqual(helper.calls.length, 0);
    assert.strictEqual(replies.length, 0);

    alive = true;
    handler({ epoch: 9 }, { id: 'phone' });
    await until(() => helper.calls.length === 1);
    assert.strictEqual(helper.calls[0].cmd, 'spacesLook');
    helper.release(SEPARATE);
    await until(() => replies.length === 1);
    assert.deepStrictEqual(replies[0], { t: P.T.SCREEN_DESKTOPS, ok: true, epoch: 9 });
    assert.strictEqual(spaceLook.current(), SEPARATE);
    assert.strictEqual(changes, 1);

    handler({ epoch: 2 }, { id: 'phone' });
    await until(() => helper.calls.length === 2);
    generation = 5;
    helper.release({ ...SEPARATE });
    await until(() => replies.length === 2);
    assert.deepStrictEqual(replies[1], { t: P.T.SCREEN_DESKTOPS, ok: false, why: 'stale', epoch: 2 });
    assert.strictEqual(spaceLook.current(), SEPARATE);

    handler({ epoch: 4 }, { id: 'phone' });
    await until(() => helper.calls.length === 3);
    alive = false;
    helper.release(SEPARATE);
    await tick();
    await tick();
    assert.strictEqual(replies.length, 2);
    assert.strictEqual(spaceLook.current(), SEPARATE);

    handler({ epoch: 1.5 }, { id: 'phone' });
    assert.strictEqual(helper.calls.length, 3);
    alive = true;
    generation = 5;
    handler({ epoch: 1.5 }, { id: 'phone' });
    await until(() => helper.calls.length === 4);
    helper.release(SEPARATE);
    await until(() => replies.length === 3);
    assert.deepStrictEqual(replies[2], { t: P.T.SCREEN_DESKTOPS, ok: true, epoch: 0 });
  }

  // A released host socket must not become the guest link's desktop request.
  // services.js passes this source into meshGate; looking the session up by id does not.
  {
    process.env.TWINDESK_NO_FX2 = '1';
    const { EventEmitter } = require('events');
    const { Hub } = require('../../mac/mesh/hub.js');
    const links = new EventEmitter();
    links.list = () => [];
    const hub = new Hub({ device: { id: 'mac', name: 'This Mac' }, links, mesh: null });
    const session = hub.sessions.ensure('phone');
    const guest = { authed: true, ws: { readyState: 1 }, pairing: {} };
    const host = { authed: true, released: true, ws: { readyState: 1 }, deviceId: 'phone', name: 'Phone' };
    session.link = guest;
    session.ctx = host;
    const seen = [];
    hub.bus.on(P.T.SCREEN_SPACE, (msg, id, source) => seen.push({ id, source, dir: msg.dir }));
    const authorize = (ctx) => S.meshGate(() => hub.sessions.get(ctx && ctx.id), ctx && ctx.source);
    session.fromHost({ t: P.T.SCREEN_SPACE, dir: 'next' }, host);
    assert.strictEqual(seen.length, 0);
    assert.strictEqual(authorize({ id: 'phone', source: host }), null);
    host.released = false;
    session.fromHost({ t: P.T.SCREEN_SPACE, dir: 'next' }, host);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].id, 'phone');
    assert.strictEqual(seen[0].source, host);
    assert.strictEqual(authorize({ id: 'phone', source: seen[0].source }), null);
    session._fromLink({ t: P.T.SCREEN_SPACE, dir: 'prev' });
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1].source, guest);
    const still = authorize({ id: 'phone', source: seen[1].source });
    assert.strictEqual(typeof still, 'function');
    assert.strictEqual(still(), true);
    guest.released = true;
    assert.strictEqual(still(), false);
    guest.released = false;
    const replaced = { authed: true, ws: { readyState: 1 }, pairing: {} };
    session.link = replaced;
    assert.strictEqual(still(), false);
    assert.strictEqual(authorize({ id: 'phone', source: replaced })(), true);
    session.fromHost({ t: P.T.SCREEN_SPACE, dir: 'next' }, { authed: true, ws: { readyState: 1 } });
    assert.strictEqual(seen.length, 2);
  }

  console.log('mac-spaces: fake helper only; arm, abort-before-press, and refusals. Not a live desktop switch.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
