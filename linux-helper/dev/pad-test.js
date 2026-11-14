// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dev check for the touchpad gestures of the Wayland backend (wl.c pad_frame, #222): with the pads
// grabbed, a tap clicks (one finger left, two right, three middle), two fingers scroll (natural
// or not, as the desktop has it) and pinch, and a slow touch or a two-finger scroll is no click.
//   sudo node linux-helper/dev/pad-test.js     (builds dev/fakepad.c on first use)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const BIN = path.join(__dirname, '..', 'bin', 'macshare-linuxhelper');
const FAKE = path.join(__dirname, '..', 'bin', 'fakepad');
if (!fs.existsSync(FAKE)) execFileSync('gcc', ['-O2', '-o', FAKE, path.join(__dirname, 'fakepad.c')]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name, cond, extra = '') => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

(async () => {
  const fake = spawn(FAKE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((r) => fake.stdout.once('data', r));
  const pad = (n, x0 = 2000, y0 = 1200, x1 = 2400, y1 = 1200) => fake.stdin.write(`f ${n} ${x0} ${y0} ${x1} ${y1}\n`);

  const h = spawn(BIN, [], { env: { ...process.env, MACSHARE_HELPER_BACKEND: 'uinput' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const events = [];
  let id = 1, buf = '';
  const waiters = new Map();
  h.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.event) events.push(m);
      else if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  const req = (cmd, a = {}) => new Promise((r) => { const n = id++; waiters.set(n, r); h.stdin.write(JSON.stringify({ ...a, cmd, id: n }) + '\n'); });
  const send = (cmd, a = {}) => h.stdin.write(JSON.stringify({ ...a, cmd }) + '\n');
  const sent = () => events.filter((e) => e.event === 'ev').map((e) => e.ev);
  const config = (o) => req('kvmConfig', { side: 'right', resistancePx: 60, hotkey: 'AltRight', driveOther: true, keyboard: true, deadmanMs: 5000, doubleTapMs: 400, ...o });

  await sleep(500);
  send('screens', { list: '0,0,1920,1080,1' });
  await config({});
  let info = await req('info');
  for (let i = 0; i < 25 && !(info.devices >= 1); i++) { await sleep(200); info = await req('info'); }
  await req('capture', { on: true, mouse: true, keyboard: true });
  const keep = setInterval(() => send('keepalive'), 300);
  await sleep(200);

  const clicks = () => sent().filter((e) => e.t === 'k.md').map((e) => e.b);
  const tap = async (n) => { events.length = 0; pad(n); await sleep(40); pad(0); await sleep(150); return clicks(); };
  ok('one-finger tap → left click', JSON.stringify(await tap(1)) === '[0]', JSON.stringify(sent()));
  ok('two-finger tap → right click', JSON.stringify(await tap(2)) === '[1]');
  ok('three-finger tap → middle click', JSON.stringify(await tap(3)) === '[2]');

  events.length = 0;
  pad(1); await sleep(300); pad(0); await sleep(150);
  ok('a long touch is no tap', clicks().length === 0);

  events.length = 0;
  pad(1, 2000, 1200);
  for (let i = 1; i <= 10; i++) { await sleep(8); pad(1, 2000 + i * 40, 1200); }
  pad(0); await sleep(150);
  ok('one finger moves the pointer, no click', sent().some((e) => e.t === 'k.mm') && clicks().length === 0);

  const scroll = async () => {
    events.length = 0;
    pad(2, 2000, 1000, 2400, 1000);
    for (let i = 1; i <= 10; i++) { await sleep(10); pad(2, 2000, 1000 + i * 40, 2400, 1000 + i * 40); } // both down 10 mm
    pad(0); await sleep(150);
    const w = sent().filter((e) => e.t === 'k.wh');
    return { dy: w.reduce((s, e) => s + e.dy, 0), mode: w[0] && w[0].mode, moves: sent().filter((e) => e.t === 'k.mm').length, clicks: clicks().length };
  };
  let r = await scroll();
  ok('two fingers down scroll down', r.dy > 20 && r.mode === 'pixel', JSON.stringify(r));
  ok('… without moving the pointer or clicking', r.moves === 0 && r.clicks === 0, JSON.stringify(r));
  await config({ padNatural: true });
  r = await scroll();
  ok('natural scrolling: the other way', r.dy < -20, JSON.stringify(r));

  events.length = 0;
  pad(2, 1800, 1200, 2200, 1200);
  for (let i = 1; i <= 10; i++) { await sleep(10); pad(2, 1800 - i * 40, 1200, 2200 + i * 40, 1200); } // apart
  pad(0); await sleep(150);
  const z = sent().filter((e) => e.t === 'k.ge' && e.g === 'zoom');
  const grow = z.filter((e) => e.phase === 'change').reduce((p, e) => p * (1 + e.v), 1);
  ok('pinch: begin, changes, end', z.length > 2 && z[0].phase === 'begin' && z[z.length - 1].phase === 'end', z.map((e) => e.phase).join(','));
  ok('spread: about twice as far apart', grow > 1.8 && grow < 3.2, grow.toFixed(2));
  ok('pinch: no scroll', !sent().some((e) => e.t === 'k.wh'));

  await config({ padTap: false });
  ok('tap to click off: no click', (await tap(1)).length === 0);

  clearInterval(keep);
  h.stdin.end();
  fake.stdin.end();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
