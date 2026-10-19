// Pooled clipboard and notifications over three devices on real sockets (mac side).
'use strict';

const assert = require('assert');
const P = require('../../shared/protocol.js');
const { runTests } = require('../../windows/test/lib/run.js');
const { node, close, waitFor, pair, linked } = require('./lib/mesh.js');
const { pooled } = require('./lib/pooled.js');

async function triangle() {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  await pair(A, B);
  await pair(A, C);
  await pair(B, C);
  const all = [[A, B], [A, C], [B, C]];
  await waitFor(() => all.every(([x, y]) => linked(x, y)), 'all three links up');
  return { A, B, C, all };
}

// Every device has accepted the pool both ways (the policies crossed the links).
async function policiesCrossed(nodes, feature) {
  await waitFor(() => nodes.every((x) => x.others.every((y) => {
    const e = x.node.mesh.get(y.node.id);
    return !!e && (feature === 'clip' ? e.pool !== false : e.notifPool === true);
  })), `${feature} policies to cross`);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a copy on one device reaches every other device once, and is not echoed back', async () => {
  const { A, B, C } = await triangle();
  try {
    const a = pooled(A);
    const b = pooled(B);
    const c = pooled(C);
    [a, b, c].forEach((x) => { x.others = [a, b, c].filter((y) => y !== x); });
    await policiesCrossed([a, b, c], 'clip');

    a.clipboard.text = 'first copy';
    a.helper.copy('first copy');
    await waitFor(() => b.clipboard.text === 'first copy' && c.clipboard.text === 'first copy', 'the copy on B and C');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(b.clipboard.writes, ['first copy'], 'B applied it once');
    assert.deepStrictEqual(c.clipboard.writes, ['first copy'], 'C applied it once');
    assert.deepStrictEqual(a.clipboard.writes, [], 'A never applies its own copy back');
    assert.deepStrictEqual(a.clip.view.history.map((h) => h.dir), ['out'], 'A remembers one outgoing item');
    assert.deepStrictEqual(b.clip.view.history.map((h) => h.dir), ['in'], 'B remembers one incoming item');
    close(A, B, C);
  } catch (e) {
    close(A, B, C);
    throw e;
  }
});

test('a copy from B is in the pool too, and the origin name is the device that copied', async () => {
  const { A, B, C } = await triangle();
  try {
    const a = pooled(A, { name: 'Mac A' });
    const b = pooled(B, { name: 'Mac B' });
    const c = pooled(C, { name: 'Mac C' });
    [a, b, c].forEach((x) => { x.others = [a, b, c].filter((y) => y !== x); });
    await policiesCrossed([a, b, c], 'clip');
    b.clipboard.text = 'from B';
    b.helper.copy('from B');
    await waitFor(() => a.clipboard.text === 'from B' && c.clipboard.text === 'from B', 'the copy from B');
    assert.strictEqual(a.clip.view.history[0].from, 'B', 'the origin is named by the mesh entry');
  } finally {
    close(A, B, C);
  }
});

test('a device that refuses clipboard from us gets nothing; the others still get it', async () => {
  const { A, B, C } = await triangle();
  try {
    const a = pooled(A);
    const b = pooled(B);
    const c = pooled(C, { clip: { receive: false } });
    [a, b, c].forEach((x) => { x.others = [a, b, c].filter((y) => y !== x); });
    await waitFor(() => A.mesh.get(C.id).pool === false, 'C switched the clipboard pool off for itself');
    a.clipboard.text = 'not for C';
    a.helper.copy('not for C');
    await waitFor(() => b.clipboard.text === 'not for C', 'the copy on B');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(c.clipboard.writes, [], 'C applies nothing');
  } finally {
    close(A, B, C);
  }
});

test('a password from a password manager (concealed) is not sent', async () => {
  const { A, B, C } = await triangle();
  try {
    const a = pooled(A);
    const b = pooled(B);
    const c = pooled(C);
    [a, b, c].forEach((x) => { x.others = [a, b, c].filter((y) => y !== x); });
    await policiesCrossed([a, b, c], 'clip');
    a.clipboard.text = 'hunter2';
    a.helper.copy('hunter2', { concealed: true });
    await waitFor(() => a.clip.view.lastSkip !== '', 'the skip note');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(b.clipboard.writes, [], 'B never got the password');
    assert.match(a.clip.view.lastSkip, /password/);
  } finally {
    close(A, B, C);
  }
});

test('a notification on one device is shown on the others once, never on its own device', async () => {
  const { A, B, C } = await triangle();
  try {
    const a = pooled(A, { name: 'Mac A' });
    const b = pooled(B, { name: 'Mac B' });
    const c = pooled(C, { name: 'Mac C' });
    [a, b, c].forEach((x) => { x.others = [a, b, c].filter((y) => y !== x); });
    await policiesCrossed([a, b, c], 'notifs');
    a.helper.notif({ id: 'n1', title: 'Hello', body: 'World' });
    await waitFor(() => b.shown.length === 1 && c.shown.length === 1, 'the notification on B and C');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(b.shown.length, 1, 'B shows it once');
    assert.strictEqual(c.shown.length, 1, 'C shows it once');
    assert.strictEqual(a.shown.length, 0, 'A never shows its own');
    assert.strictEqual(b.shown[0].opts.title, 'Hello');
    assert.strictEqual(b.shown[0].opts.subtitle, 'Mail · A', 'the subtitle names the app and the device it came from');
    // The echo guard: what B shows is not sent back to the pool when the OS reports it.
    b.helper.notif({ id: 'n1', title: 'Hello', body: 'World' });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(a.shown.length, 0, 'no echo back to A');
  } finally {
    close(A, B, C);
  }
});

test('notifications off for a device (notif.policy) are not sent to it', async () => {
  const { A, B, C } = await triangle();
  try {
    const a = pooled(A);
    const b = pooled(B, { notifs: { receive: false } });
    const c = pooled(C);
    [a, b, c].forEach((x) => { x.others = [a, b, c].filter((y) => y !== x); });
    await waitFor(() => A.mesh.get(B.id).notifPool === false && A.mesh.get(C.id).notifPool === true, 'the notif policies');
    a.helper.notif({ id: 'n2', title: 'Only C' });
    await waitFor(() => c.shown.length === 1, 'the notification on C');
    assert.strictEqual(b.shown.length, 0, 'B refused it');
  } finally {
    close(A, B, C);
  }
});

test('a Mac that is a guest speaks its native role: stream.stop out, rtc2.stop in', async () => {
  const A = await node('A'); // A dials B: A is the guest
  const B = await node('B');
  try {
    await pair(A, B);
    await waitFor(() => linked(A, B), 'the link');
    const seenB = [];
    const seenA = [];
    B.hub.sessions.ensure(A.id).on('rtc2.stop', (m) => seenB.push(m.t));
    A.hub.sessions.ensure(B.id).on('stream.stop', (m) => seenA.push(m.t));
    assert.ok(A.hub.sessions.get(B.id).send({ t: 'stream.stop' }), 'A sends stream.stop');
    await waitFor(() => seenB.length === 1, 'the swapped message on B');
    assert.deepStrictEqual(seenB, ['rtc2.stop'], 'B (the host) gets the other computer\'s name');
    B.hub.sessions.get(A.id).send({ t: 'rtc2.stop' });
    await waitFor(() => seenA.length === 1, 'the reply on A');
    assert.deepStrictEqual(seenA, ['stream.stop'], 'A (the guest) gets its own name back');
    assert.strictEqual(P.ROLE_SWAP['stream.stop'], 'rtc2.stop');
  } finally {
    close(A, B);
  }
});

runTests(tests);
