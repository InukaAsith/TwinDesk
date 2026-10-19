// The keep-alive in real time: a busy link pings about every second, an idle link about every five
// seconds. Pings are counted on both ends of the one socket. A ping is only sent when nothing was
// sent on the link for the interval, and a pong is a send too, so the side that hears silence pings
// and the other one answers: a busy link carries about one ping per second in total.
'use strict';

const assert = require('assert');
const { runTests } = require('./lib/run.js');
const { node, close, waitFor, pair } = require('./lib/mesh.js');

function countPings(ws) {
  const counter = { n: 0 };
  const send = ws.send.bind(ws);
  ws.send = (data, ...rest) => {
    if (String(data).includes('"t":"ping"')) counter.n++;
    return send(data, ...rest);
  };
  return counter;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a busy link pings about every second and an idle link about every five seconds', async () => {
  const A = await node('A');
  const B = await node('B');
  try {
    await pair(A, B);
    await waitFor(() => A.links.get(B.id).authed && B.server.clients.get(A.id), 'linked');
    const aSide = countPings(A.links.get(B.id).ws);
    const bSide = countPings(B.server.clients.get(A.id).ws);

    A.links.setBusy(B.id, true);
    B.server.setBusy(A.id, true);
    await new Promise((r) => setTimeout(r, 3600));
    const busy = aSide.n + bSide.n;
    assert.ok(busy >= 2 && busy <= 6, `busy link sent ${busy} pings in 3.6 s, expected about 3`);

    A.links.setBusy(B.id, false);
    B.server.setBusy(A.id, false);
    await new Promise((r) => setTimeout(r, 1000));
    const before = aSide.n + bSide.n;
    await new Promise((r) => setTimeout(r, 11500));
    const idle = aSide.n + bSide.n - before;
    assert.ok(idle >= 1 && idle <= 4, `idle link sent ${idle} pings in 11.5 s, expected about 2`);
    assert.ok(A.links.get(B.id).authed, 'still linked');
  } finally {
    close(A, B);
  }
});

runTests(tests);
