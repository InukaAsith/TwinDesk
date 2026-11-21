// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { execFileSync, spawn } = require('child_process');
const { createInterface } = require('readline');

const LOGIN1 = 'org.freedesktop.login1';
const ROOT = '/org/freedesktop/login1';
const DEST = ['--system', '--dest', LOGIN1];

function call(path, method, ...args) {
  return execFileSync('gdbus', ['call', ...DEST, '--object-path', path, '--method', method, ...args], {
    encoding: 'utf8', timeout: 300, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function properties(path) {
  return call(path, 'org.freedesktop.DBus.Properties.GetAll', `${LOGIN1}.Session`);
}

// Electron has no Linux lock-screen events. Watch this logind session for both lock edges and
// changes of the active desktop, and check the same session synchronously before acting.
function watchLinuxSession(reset, onChange) {
  let path, id;
  try {
    // loginctl lock-session targets the caller's 'auto' session too.
    path = call(ROOT, `${LOGIN1}.Manager.GetSession`, 'auto').match(/'(\/org\/freedesktop\/login1\/session\/\w+)'/)?.[1];
    if (!path) return null;
    const state = properties(path);
    id = state.match(/'Id': <'([^']+)'>/)?.[1];
    if (!id || !/'Type': <'(wayland|x11)'>/.test(state) || /'CanLock': <false>/.test(state) || !state.includes("'LockedHint'")) return null;
  } catch {
    return null;
  }

  let watching = false, lockRequested = false, stopped = false;
  const available = (on) => {
    if (stopped || watching === on) return;
    watching = on;
    lockRequested = false;
    reset();
    onChange();
  };
  const monitor = spawn('gdbus', ['monitor', ...DEST, '--object-path', path], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
  });
  const output = createInterface({ input: monitor.stdout });
  output.on('line', (line) => {
    if (line.startsWith(`The name ${LOGIN1} is owned by `)) return available(true);
    if (line === `The name ${LOGIN1} does not have an owner`) return available(false);
    if (!watching || !line.startsWith(`${path}: `)) return;
    const signal = line.slice(path.length + 2);
    if (signal.startsWith(`${LOGIN1}.Session.Lock `)) {
      lockRequested = true;
    } else if (signal.startsWith(`${LOGIN1}.Session.Unlock `)) {
      lockRequested = false;
    } else if (signal.startsWith("org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session',") && /'(Active|LockedHint)'/.test(signal)) {
      if (signal.includes("'LockedHint'")) lockRequested = false;
    } else {
      return;
    }
    reset();
  });
  monitor.on('error', () => available(false));
  monitor.on('exit', () => available(false));
  output.on('close', () => available(false));

  return {
    get supported() { return watching; },
    unlocked() {
      if (!watching || lockRequested) return false;
      try {
        const state = properties(`${ROOT}/session/auto`);
        return state.includes(`'Id': <'${id}'>`) && state.includes("'Active': <true>") && state.includes("'LockedHint': <false>");
      } catch {
        return false;
      }
    },
    stop() {
      stopped = true;
      watching = false;
      output.close();
      monitor.kill();
    },
  };
}

module.exports = { watchLinuxSession };
