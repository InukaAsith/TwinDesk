// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dev check for the helper's Wayland backend (wl.c): screens, absolute moves through
// the virtual pointer (read back from its /dev/input node), edge push from a fake mouse, capture
// (grab, motion, keys forwarded), the hotkey, injected moves and the return edge, dead-man.
// Needs /dev/uinput and /dev/input access (run as root in WSL, or a user in the input group):
//   sudo node linux-helper/dev/wl-test.js
// Fakes the hands with fakedev.c (built on first use).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const BIN = path.join(__dirname, '..', 'bin', 'macshare-linuxhelper');
const FAKE = path.join(__dirname, '..', 'bin', 'fakedev');
if (!fs.existsSync(FAKE)) execFileSync('gcc', ['-O2', '-o', FAKE, path.join(__dirname, 'fakedev.c')]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));

// The virtual pointer's node: read ABS_X / ABS_Y back.
function findNode(name) {
  const t = fs.readFileSync('/proc/bus/input/devices', 'utf8');
  for (const block of t.split('\n\n')) {
    if (!block.includes('N: Name="' + name + '"')) continue;
    const m = /H: Handlers=.*?(event\d+)/.exec(block);
    if (m) return '/dev/input/' + m[1];
  }
  return null;
}

(async () => {
  const fake = spawn(FAKE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((r) => fake.stdout.once('data', r));
  const hand = (line) => fake.stdin.write(line + '\n');

  const h = spawn(BIN, [], { env: { ...process.env, MACSHARE_HELPER_BACKEND: 'uinput' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const events = [];
  let id = 1;
  const waiters = new Map();
  let buf = '';
  h.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      if (m.event) events.push(m);
      else if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  const req = (cmd, a = {}) => new Promise((r) => { const n = id++; waiters.set(n, r); h.stdin.write(JSON.stringify({ ...a, cmd, id: n }) + '\n'); });
  const send = (cmd, a = {}) => h.stdin.write(JSON.stringify({ ...a, cmd }) + '\n');
  const take = (name) => { const i = events.findIndex((e) => e.event === name); return i < 0 ? null : events.splice(i, 1)[0]; };

  await sleep(500);
  const ready = take('ready');
  ok('ready (uinput)', ready && ready.backend === 'uinput', JSON.stringify(ready));
  send('screens', { list: '0,0,1920,1080,1' });
  await req('kvmConfig', { side: 'right', resistancePx: 60, hotkey: 'AltRight', driveOther: true, keyboard: true, deadmanMs: 1500, doubleTapMs: 400 });
  let info = await req('info');
  for (let i = 0; i < 25 && !(info.devices >= 1); i++) { await sleep(200); info = await req('info'); } // hot-plug rescan
  ok('fake devices found', info.devices >= 1, JSON.stringify(info));

  // 1. absolute move lands where asked (read from the virtual pointer's node)
  await sleep(300);
  const node = findNode('TwinDesk virtual pointer');
  ok('virtual pointer node', !!node, node || '');
  const absSeen = [];
  let rd = null;
  if (node) {
    rd = fs.createReadStream(node);
    rd.on('error', () => {}); // the node goes away with the helper
    rd.on('data', (b) => {
      for (let o = 0; o + 24 <= b.length; o += 24) {
        const type = b.readUInt16LE(o + 16), code = b.readUInt16LE(o + 18), value = b.readInt32LE(o + 20);
        if (type === 3) absSeen.push([code, value]);
      }
    });
  }
  await sleep(100);
  await req('moveTo', { x: 960, y: 540 });
  await sleep(150);
  const ax = absSeen.filter(([c]) => c === 0).pop();
  ok('moveTo → ABS_X at the middle', ax && Math.abs(ax[1] - 32784) < 40, JSON.stringify(ax));
  info = await req('info');
  ok('position followed', info.cursor[0] === 960 && info.cursor[1] === 540, JSON.stringify(info.cursor));

  // 2. edge: our pointer at the right edge, the fake mouse keeps pushing
  await req('moveTo', { x: 1919, y: 270 });
  for (let i = 0; i < 12; i++) { hand('rel 10 0'); await sleep(15); }
  await sleep(200);
  const edge = take('edge');
  ok('edge event', !!edge, JSON.stringify(edge));
  info = await req('info');
  ok('capturing after edge', info.capturing === true);

  // 3. motion and keys while capturing are forwarded
  const keep = setInterval(() => send('keepalive'), 300);
  events.length = 0;
  hand('rel -30 5');
  await sleep(120);
  ok('k.mm forwarded', events.some((e) => e.event === 'ev' && e.ev.t === 'k.mm'));
  events.length = 0;
  hand('key 30 1'); hand('key 30 0'); // A
  await sleep(120);
  const keys = events.filter((e) => e.event === 'ev' && /^k\.k/.test(e.ev.t)).map((e) => e.ev.t + ':' + e.ev.code);
  ok('keys forwarded', keys.includes('k.kd:KeyA') && keys.includes('k.ku:KeyA'), keys.join(','));
  events.length = 0;
  hand('btn 272 1'); hand('btn 272 0'); // BTN_LEFT
  await sleep(120);
  ok('buttons forwarded', events.filter((e) => e.event === 'ev' && /^k\.m[du]$/.test(e.ev.t)).length === 2);

  // 4. hotkey double-tap while capturing: hotkey event, capture ends, taps never sent
  events.length = 0;
  for (let i = 0; i < 2; i++) { hand('key 100 1'); await sleep(30); hand('key 100 0'); await sleep(60); }
  await sleep(150);
  const hk = take('hotkey');
  ok('hotkey while capturing', hk && hk.wasCapturing === true, JSON.stringify(hk));
  ok('hotkey taps not sent', !events.some((e) => e.event === 'ev' && e.ev.code === 'AltRight'));
  info = await req('info');
  ok('capture ended', info.capturing === false);
  clearInterval(keep);

  // 5. injected moves reach the return edge
  await req('kvmConfig', { side: 'right', resistancePx: 60, hotkey: 'AltRight', driveOther: false, keyboard: true, deadmanMs: 1500, doubleTapMs: 400 });
  await req('place', { side: 'left', offset: 0.5 });
  await req('armReturn', { on: true, side: 'right', resistancePx: 60 });
  for (let i = 0; i < 30; i++) send('inject', { ev: { t: 'k.mm', dx: 100, dy: 0 } });
  await sleep(300);
  const ret = take('return');
  ok('return edge after injected moves', !!ret, JSON.stringify(ret));

  // 6. dead-man
  await req('kvmConfig', { side: 'right', resistancePx: 60, hotkey: 'AltRight', driveOther: true, keyboard: true, deadmanMs: 600, doubleTapMs: 400 });
  await req('capture', { on: true, mouse: true, keyboard: true });
  await sleep(1200);
  const dm = take('captureEnded');
  ok('dead-man ends capture', dm && dm.reason === 'deadman', JSON.stringify(dm));

  // 7. Multi-device's monitor map (#225): two watched sides (sideList), zones per side. The top only
  // crosses on its right half, the left side anywhere; each edge event names its side.
  await req('kvmConfig', { side: 'top', sideList: 'top,left', zones: 'top:0.5-1.0,left:0.0-1.0', resistancePx: 60, hotkey: 'AltRight', driveOther: true, keyboard: true, deadmanMs: 1500, doubleTapMs: 400 });
  const pushAt = async (x, y, dx, dy) => { await req('moveTo', { x, y }); await sleep(300); events.length = 0; for (let i = 0; i < 12; i++) { hand(`rel ${dx} ${dy}`); await sleep(15); } await sleep(200); return take('edge'); };
  let e7 = await pushAt(300, 0, 0, -10);
  ok('top, left half: no crossing', !e7, JSON.stringify(e7));
  e7 = await pushAt(1500, 0, 0, -10);
  ok('top, right half: crosses, side named', e7 && e7.side === 'top', JSON.stringify(e7));
  await req('capture', { on: false });
  await sleep(400);
  e7 = await pushAt(0, 700, -10, 0);
  ok('left: crosses, side named', e7 && e7.side === 'left', JSON.stringify(e7));
  await req('capture', { on: false });

  if (rd) rd.destroy();
  h.stdin.end();
  fake.stdin.end();
  await sleep(300);
  process.exit(0);
})();
