// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/obs.js against a stand-in obs-websocket 5 server: the password challenge, a tile's request,
// the state for the Deck, OBS not running, a wrong password, and the Deck's obs action.
// Run with: node shared/test/obs.js
'use strict';

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { Obs, authOf } = require('../obs.js');
const M = require('../deck-model.js');

let WS;
for (const p of ['ws', ...['mac', 'windows', 'linux'].map((d) => path.join(__dirname, '..', '..', d, 'node_modules', 'ws'))]) {
  try { WS = require(p); break; } catch (_) {}
}

// obs-websocket's own worked example (its protocol docs).
assert.strictEqual(authOf('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY='), '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');

// The model keeps an obs action's name only where it needs one.
assert.deepStrictEqual(M.action({ k: 'obs', what: 'scene', name: 'Desk\ncam' }), { k: 'obs', what: 'scene', name: 'Desk cam' });
assert.deepStrictEqual(M.action({ k: 'obs', what: 'record', name: 'x' }), { k: 'obs', what: 'record' });
assert.deepStrictEqual(M.action({ k: 'obs', what: 'rm -rf' }), { k: 'obs', what: 'record' });

function fakeObs(pass) {
  const server = new WS.WebSocketServer({ host: '127.0.0.1', port: 0 });
  const seen = [];
  const st = { record: false };
  server.on('connection', (s) => {
    const salt = crypto.randomBytes(8).toString('base64'), challenge = crypto.randomBytes(8).toString('base64');
    s.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, ...(pass ? { authentication: { salt, challenge } } : {}) } }));
    s.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.op === 1) {
        if (pass && m.d.authentication !== authOf(pass, salt, challenge)) return s.close(4009, 'Authentication failed.');
        return s.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      }
      if (m.op !== 6) return;
      seen.push(m.d);
      const ok = (responseData) => s.send(JSON.stringify({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData } }));
      const no = (code, comment) => s.send(JSON.stringify({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: false, code, comment } } }));
      switch (m.d.requestType) {
        case 'ToggleRecord': st.record = !st.record; return ok({ outputActive: st.record });
        case 'GetRecordStatus': return ok({ outputActive: st.record, outputPaused: false });
        case 'GetStreamStatus': return ok({ outputActive: false });
        case 'GetSceneList': return ok({ currentProgramSceneName: 'Desk', scenes: [{ sceneName: 'BRB' }, { sceneName: 'Desk' }] });
        case 'GetInputList': return ok({ inputs: [{ inputName: 'Mic/Aux' }] });
        case 'GetVirtualCamStatus': return ok({ outputActive: false });
        case 'SetCurrentProgramScene': return m.d.requestData.sceneName === 'Desk' ? ok() : no(600, 'No source was found by the name of `Nope`.');
        default: return no(204, 'Unknown request');
      }
    });
  });
  return new Promise((r) => server.on('listening', () => r({ server, port: server.address().port, seen, st })));
}

(async () => {
  if (!WS) { console.log('obs: skipped (no ws)'); return; }
  // With a password.
  const a = await fakeObs('hunter2');
  const obs = new Obs({ config: () => ({ port: a.port, pass: 'hunter2' }) });
  await obs.run('record');
  assert.strictEqual(a.st.record, true);
  const st = await obs.state();
  assert.deepStrictEqual(st, { on: true, record: true, paused: false, stream: false, vcam: false, scene: 'Desk', scenes: ['Desk', 'BRB'], inputs: ['Mic/Aux'] });
  await obs.run('scene', 'Desk');
  await assert.rejects(obs.run('scene', 'Nope'), /No source was found/);
  await assert.rejects(obs.run('scene', ''), /No scene or source/);
  obs.close();
  // Wrong or missing password: says where to set it.
  const bad = new Obs({ config: () => ({ port: a.port, pass: 'nope' }) });
  await assert.rejects(bad.run('record'), /password/);
  const none = new Obs({ config: () => ({ port: a.port }) });
  await assert.rejects(none.run('record'), /password/);
  assert.deepStrictEqual((await none.state()).on, false);
  a.server.close();
  // OBS not running: a clear reason, no throw from state().
  const off = new Obs({ config: () => ({ port: a.port }) });
  await assert.rejects(off.run('stream'), /OBS isn’t running/);
  assert.strictEqual((await off.state()).on, false);
  // No password asked for.
  const b = await fakeObs('');
  const open = new Obs({ config: () => ({ port: b.port }) });
  await open.run('record');
  assert.strictEqual(b.seen[0].requestType, 'ToggleRecord');
  open.close();
  b.server.close();
  console.log('obs: ok');
})().catch((e) => { console.error(e); process.exit(1); });
