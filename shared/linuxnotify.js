// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Linux, Notifications › Pop-ups: System: a phone's notification as the system's own, with its
// buttons (Mark as read…, a one-time code's Copy), which Electron's Linux notifications can't have
// (they only take a click). notify-send --action (libnotify 0.7.9 and later) waits for the click and
// says which button it was. Without it (older, or not installed): null, and the caller shows
// Electron's plain notification as before. Sent as "TwinDesk", so notifs.js's own watch skips it
// (never sent back to the phone).
//   const h = show({ title, body, icon: NativeImage|path, actions: ['Copy 123456', 'Mark as read'], onAction(i), onClick(), onClose() })
//   h.close()
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const WAIT_MS = 60000; // as long as a notification is kept here
let can = null;

function supported() {
  if (can !== null) return can;
  if (process.platform !== 'linux') return (can = false);
  try {
    can = /--action/.test(execFileSync('notify-send', ['--help'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (_) {
    can = false;
  }
  return can;
}

// notify-send takes an icon as a file: a NativeImage goes in the temp folder once per picture.
const iconFiles = new Map();
function iconPath(icon) {
  if (!icon) return '';
  if (typeof icon === 'string') return icon;
  try {
    const png = icon.toPNG();
    if (!png || !png.length) return '';
    const key = crypto.createHash('sha1').update(png).digest('hex').slice(0, 16);
    if (iconFiles.has(key)) return iconFiles.get(key);
    const file = path.join(os.tmpdir(), `twindesk-notif-${key}.png`);
    fs.writeFileSync(file, png);
    iconFiles.set(key, file);
    if (iconFiles.size > 100) iconFiles.delete(iconFiles.keys().next().value);
    return file;
  } catch (_) {
    return '';
  }
}

const clean = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, n);

function show({ title, body, icon, actions, onAction, onClick, onClose }) {
  const btns = (actions || []).filter(Boolean).slice(0, 4);
  if (!btns.length || !supported()) return null;
  const args = ['--app-name=TwinDesk', '--wait', `--expire-time=${WAIT_MS}`];
  const ico = iconPath(icon);
  if (ico) args.push(`--icon=${ico}`);
  btns.forEach((a, i) => args.push(`--action=a${i}=${clean(a, 40)}`));
  args.push('--action=default=Open'); // the notification's own click (not a button on most desktops)
  args.push('--', String(title || ' ').slice(0, 200), String(body || '').slice(0, 1000));
  let p;
  try {
    p = spawn('notify-send', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return null;
  }
  let out = '';
  let done = false;
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => { can = false; });
  p.on('close', () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const key = out.trim().split('\n').pop();
    const m = /^a(\d)$/.exec(key);
    try {
      if (m && onAction) onAction(Number(m[1]));
      else if (key === 'default' && onClick) onClick();
    } catch (_) { /* its handler's */ }
    if (onClose) onClose();
  });
  const timer = setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, WAIT_MS + 5000);
  if (timer.unref) timer.unref();
  return { close() { try { p.kill(); } catch (_) { /* gone */ } } };
}

module.exports = { show, supported };
