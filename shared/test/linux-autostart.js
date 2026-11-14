// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// linux/autostart.js: the "Open at login" entry, ~/.config/autostart/twindesk.desktop.
//   - for an ordinary path, its Exec line has no $ and no backslash: systemd's XDG autostart
//     generator (KDE Plasma 6) kept the backslash of "exec \"\$0\" ...", so sh ran a command
//     named $0 and exited 127 (#189)
//   - read the way the Desktop Entry spec says, the line starts the app with --hidden and its
//     stdout and stderr go to /dev/null (#162), also for a path with spaces, ', ", $ and %
//   - refresh() rewrites an entry an older version wrote; set(false) removes it
// Run with: node shared/test/linux-autostart.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-autostart-'));
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');
delete process.env.TWINDESK_BIN;

// autostart.js asks electron's app how it was started; stub it so it loads under plain node.
const load = Module._load;
Module._load = function (id, ...args) {
  return id === 'electron' ? { app: { isPackaged: true, getAppPath: () => dir } } : load.call(this, id, ...args);
};
const autostart = require('../../linux/autostart.js');
Module._load = load;

const desktop = path.join(process.env.XDG_CONFIG_HOME, 'autostart', 'twindesk.desktop');
const execLine = () => fs.readFileSync(desktop, 'utf8').split('\n').find((l) => l.startsWith('Exec=')).slice(5);

// The Exec value as the Desktop Entry spec reads it: the string escapes first, then the quoting (a
// character after a backslash inside double quotes is itself), then %% is %.
function argv(value) {
  const v = value.replace(/\\([sntr\\])/g, (_, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c]);
  const out = [];
  for (let i = 0; i < v.length;) {
    if (v[i] === ' ') { i++; continue; }
    let a = '';
    if (v[i] === '"') {
      for (i++; v[i] !== '"'; i++) {
        assert.ok(i < v.length, 'unterminated quote in ' + value);
        if (v[i] === '\\') i++;
        a += v[i];
      }
      i++;
    } else {
      while (i < v.length && v[i] !== ' ') a += v[i++];
    }
    out.push(a.replace(/%%/g, '%'));
  }
  return out;
}

const apps = [
  [path.join(dir, 'Applications', 'TwinDesk.AppImage'), true],
  [path.join(dir, 'My Apps', 'TwinDesk.AppImage'), true],
  [path.join(dir, 'it\'s "$HOME" 100%', 'TwinDesk.AppImage'), false],
];
for (const [app, ordinary] of apps) {
  process.env.APPIMAGE = app;
  autostart.set(true);
  assert.strictEqual(autostart.get(), true);
  const exec = execLine();
  if (ordinary) assert.ok(!/[$\\]/.test(exec), 'Exec has a $ or a backslash: ' + exec);

  const args = argv(exec);
  assert.deepStrictEqual(args.slice(0, 2), ['sh', '-c']);
  assert.strictEqual(args.length, 3, 'the command is inside sh\'s script: ' + exec);
  if (process.platform === 'win32') continue;

  // A stand-in AppImage that notes its arguments and writes to stdout and stderr.
  const ran = path.join(dir, 'ran.txt');
  fs.rmSync(ran, { force: true });
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.writeFileSync(app, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAN"\necho out\necho err >&2\n', { mode: 0o755 });
  const r = spawnSync(args[0], args.slice(1), { env: { ...process.env, RAN: ran }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `exit ${r.status} for ${exec}: ${r.stderr}`);
  assert.strictEqual(r.stdout + r.stderr, '', 'output not sent to /dev/null');
  assert.strictEqual(fs.readFileSync(ran, 'utf8'), '--hidden\n');
}

// An entry from an older version (sh's "$0" and "$@") is written again.
process.env.APPIMAGE = apps[0][0];
fs.writeFileSync(desktop, '[Desktop Entry]\nType=Application\nName=TwinDesk\nExec=sh -c "exec \\\\"\\\\$0\\\\" \\\\"\\\\$@\\\\" >/dev/null 2>&1" ' + apps[0][0] + ' --hidden\n');
autostart.refresh();
assert.ok(!/[$\\]/.test(execLine()), 'refresh() kept the old entry: ' + execLine());

autostart.set(false);
assert.strictEqual(autostart.get(), false);
assert.ok(!fs.existsSync(desktop));

fs.rmSync(dir, { recursive: true, force: true });
console.log('linux-autostart: passed');
