// TwinDesk Drive's engine (shared/drive.js): devices in temp folders, synced by hand.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Drive, cleanRel, cmp, conflictName, holdable } = require('../drive.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-drive-'));
let clock = Date.now() + 60000; // ahead, so every file counts as settled
const tick = () => (clock += 60000);

function device(id, name = id, platform = 'linux') {
  const dir = path.join(base, id);
  const trashDir = path.join(base, id + '-trash');
  fs.mkdirSync(trashDir, { recursive: true });
  const d = new Drive({
    me: id, meName: name, folder: () => path.join(dir, 'Drive'), indexFile: path.join(dir, 'index.json'), watch: false, platform,
    now: () => clock,
    trash: async (abs) => fs.renameSync(abs, path.join(trashDir, path.basename(abs) + '.' + Math.random().toString(36).slice(2))),
  });
  d.dir = path.join(dir, 'Drive');
  d.trashDir = trashDir;
  d.sent = [];
  d.on('changed', (e) => d.sent.push(...e));
  return d;
}

const file = (d, rel) => path.join(d.dir, ...rel.split('/'));
function write(d, rel, text, mtime = clock - 10000) {
  fs.mkdirSync(path.dirname(file(d, rel)), { recursive: true });
  fs.writeFileSync(file(d, rel), text);
  const t = new Date(mtime);
  fs.utimesSync(file(d, rel), t, t);
}
const read = (d, rel) => (fs.existsSync(file(d, rel)) ? fs.readFileSync(file(d, rel), 'utf8') : null);
const list = (d) => {
  const out = [];
  const walk = (dir, rel) => {
    for (const n of fs.readdirSync(dir).sort()) {
      if (n === '.twindesk') continue;
      const a = path.join(dir, n), r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(a).isDirectory()) walk(a, r);
      else out.push(r);
    }
  };
  walk(d.dir, '');
  return out;
};

// One round from a to b: b merges a's entries and downloads what it needs from a.
async function oneWay(a, b) {
  const pulls = await b.merge(a.entries(), a.meName);
  for (const p of pulls) {
    const src = await a.open(p.p, p.h);
    if (!src) { b.release(p); continue; }
    const tmp = b.tempPath();
    fs.copyFileSync(src.abs, tmp);
    await b.adopt(p, tmp);
  }
  return pulls.length;
}

// Until nothing moves between any two of them.
async function sync(...ds) {
  for (let round = 0; round < 10; round++) {
    let moved = 0;
    for (const d of ds) await d.scan();
    for (const a of ds) for (const b of ds) if (a !== b) moved += await oneWay(a, b);
    for (const d of ds) await d.scan();
    if (!moved) return;
  }
  throw new Error('never settled');
}

(async () => {
  // ---- pure helpers ----
  assert.strictEqual(cmp({ a: 2 }, { a: 1 }), 'gt');
  assert.strictEqual(cmp({ a: 1 }, { a: 1, b: 1 }), 'lt');
  assert.strictEqual(cmp({ a: 2 }, { a: 1, b: 1 }), 'cc');
  assert.strictEqual(cmp({}, {}), 'eq');
  for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a\\b', '', 'a//b', '.twindesk/x', 'x/./y']) assert.strictEqual(cleanRel(bad), null, bad);
  assert.strictEqual(cleanRel('docs/Résumé.txt'.normalize('NFD')), 'docs/Résumé.txt'.normalize('NFC'));
  assert.ok(!holdable('a:b.txt', 'win32') && !holdable('con.txt', 'win32') && !holdable('x.', 'win32') && holdable('a:b.txt', 'darwin'));
  assert.ok(/^r \(conflict from Mac \d{4}-\d\d-\d\d \d{4}\)\.txt$/.test(conflictName('r.txt', 'Mac', Date.now())));
  assert.ok(conflictName('d/r', 'Mac', Date.now()).startsWith('d/r (conflict from Mac '));

  // ---- two devices ----
  const a = device('aaa', 'Mac'), b = device('bbb', 'PC');
  await a.start();
  await b.start();
  write(a, 'notes.txt', 'one');
  write(a, 'photos/2026/x.jpg', 'jpeg');
  write(b, 'from-b.txt', 'b');
  await sync(a, b);
  assert.deepStrictEqual(list(a), ['from-b.txt', 'notes.txt', 'photos/2026/x.jpg']);
  assert.deepStrictEqual(list(b), list(a));
  assert.strictEqual(read(b, 'photos/2026/x.jpg'), 'jpeg');

  // An edit goes across; the old version goes to the Trash there, never lost.
  tick();
  write(b, 'notes.txt', 'two');
  await sync(a, b);
  assert.strictEqual(read(a, 'notes.txt'), 'two');
  assert.ok(fs.readdirSync(a.trashDir).some((n) => n.startsWith('notes.txt')));

  // A deletion goes across, to the Trash, and an emptied folder goes too.
  tick();
  fs.rmSync(file(a, 'photos/2026/x.jpg'));
  await sync(a, b);
  assert.strictEqual(read(b, 'photos/2026/x.jpg'), null);
  assert.ok(!fs.existsSync(path.join(b.dir, 'photos')));
  assert.ok(fs.readdirSync(b.trashDir).some((n) => n.startsWith('x.jpg')));

  // Both edit the same file while apart: a conflict copy, nothing lost, the same on both.
  tick();
  write(a, "notes.txt", "mac edit", clock - 10000);
  write(b, "notes.txt", "pc edit", clock - 9000); // later: the PC wins
  await sync(a, b);
  assert.strictEqual(read(a, 'notes.txt'), 'pc edit');
  assert.strictEqual(read(b, 'notes.txt'), 'pc edit');
  const copy = list(a).find((n) => n.startsWith('notes (conflict from Mac'));
  assert.ok(copy, 'the conflict copy is there');
  assert.strictEqual(read(a, copy), 'mac edit');
  assert.strictEqual(read(b, copy), 'mac edit');
  assert.deepStrictEqual(list(a), list(b));

  // Deleted on one, edited on the other: the edit stays.
  tick();
  fs.rmSync(file(a, 'from-b.txt'));
  write(b, 'from-b.txt', 'still here');
  await sync(a, b);
  assert.strictEqual(read(a, 'from-b.txt'), 'still here');
  assert.strictEqual(read(b, 'from-b.txt'), 'still here');

  // The same new file on both: no conflict.
  tick();
  write(a, 'same.txt', 'identical');
  write(b, "same.txt", "identical", clock - 5000);
  await sync(a, b);
  assert.ok(!list(a).some((n) => n.startsWith('same (conflict')));

  // Unchanged files aren't sent again, and system clutter never is.
  await sync(a, b);
  a.sent.length = 0;
  write(a, '.DS_Store', 'x');
  write(a, '~$report.docx', 'lock');
  write(a, 'movie.mp4.crdownload', 'partial');
  await a.scan();
  assert.deepStrictEqual(a.sent, []);

  // The index survives a restart: nothing looks new.
  await a.stop();
  const a2 = new Drive({ me: 'aaa', meName: 'Mac', folder: () => a.dir, indexFile: path.join(base, 'aaa', 'index.json'), watch: false, now: () => clock, trash: async () => {} });
  const again = [];
  a2.on('changed', (e) => again.push(...e));
  await a2.start();
  assert.deepStrictEqual(again, []);
  await a2.stop();
  await a.start();

  // A download that doesn't match its hash is thrown away.
  tick();
  write(b, 'evil.txt', 'real');
  await b.scan();
  const [p] = await a.merge(b.entries(), 'PC');
  const tmp = a.tempPath();
  fs.writeFileSync(tmp, 'tampered');
  assert.strictEqual(await a.adopt(p, tmp), false);
  assert.strictEqual(read(a, 'evil.txt'), null);
  assert.ok(!fs.existsSync(tmp));
  await sync(a, b);
  assert.strictEqual(read(a, 'evil.txt'), 'real');

  // Paths from another device can't leave the folder.
  const outside = path.join(base, 'escaped.txt');
  const bad = [{ p: '../escaped.txt', s: 1, m: clock, h: 'a'.repeat(64), d: false, v: { bbb: 9 }, by: 'bbb' }];
  assert.deepStrictEqual(await a.merge(bad, 'PC'), []);
  assert.ok(!fs.existsSync(outside));

  // Serving: only the version asked for, as it is on disk.
  const e = b.entries().find((x) => x.p === 'evil.txt');
  assert.ok(await b.open('evil.txt', e.h));
  assert.strictEqual(await b.open('evil.txt', 'f'.repeat(64)), null);
  assert.strictEqual(await b.open('../index.json', e.h), null);

  // A name Windows can't hold is skipped on Windows, and doesn't come back as a deletion.
  const w = device('www', 'Win', 'win32');
  await w.start();
  tick();
  write(b, 'what?.txt', 'q');
  await sync(a, b, w);
  assert.strictEqual(read(w, 'what?.txt'), null);
  assert.strictEqual(read(a, 'what?.txt'), 'q');
  assert.ok(w.status().skipped >= 1);

  // ---- three devices: a change goes through the one in the middle ----
  const c = device('ccc', 'Linux');
  await c.start();
  await sync(b, c); // c meets only b
  tick();
  write(a, 'relay.txt', 'via b');
  await sync(a, b); // a and b meet
  await sync(b, c); // later, b and c
  assert.strictEqual(read(c, 'relay.txt'), 'via b');
  tick();
  fs.rmSync(file(c, 'relay.txt'));
  await sync(b, c);
  await sync(a, b);
  assert.strictEqual(read(a, 'relay.txt'), null);

  // A download on its way isn't taken for a deletion by a scan meanwhile.
  tick();
  write(b, 'slow.bin', 'big');
  await b.scan();
  const pulls = await c.merge(b.entries(), 'PC');
  const slow = pulls.find((x) => x.p === 'slow.bin');
  c.sent.length = 0;
  await c.scan();
  assert.ok(!c.sent.some((x) => x.p === 'slow.bin' && x.d));
  const t2 = c.tempPath();
  fs.copyFileSync((await b.open(slow.p, slow.h)).abs, t2);
  assert.strictEqual(await c.adopt(slow, t2), true);
  for (const x of pulls) if (x !== slow) c.release(x);

  for (const d of [a, b, c, w]) await d.stop();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('drive: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
