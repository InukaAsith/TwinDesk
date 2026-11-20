// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An app window's app, started on its virtual display. scrcpy's start_app only names the display,
// and HyperOS/MIUI then opens the app as a small floating (freeform) window in the middle of it,
// which the phone window can't make bigger (#265). There it's started through adb with full-screen
// windowing (`am start --display N --windowingMode 1`); everywhere else, and whenever that fails,
// through scrcpy as before.
'use strict';

const FREEFORM_MAKERS = /xiaomi|redmi|poco/i;
const PKG = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;

// scrcpy's "New display: 1080x2400/440 (id=12)" among the server's lines.
function displayIdOf(log) {
  for (let i = (log || []).length - 1; i >= 0; i--) {
    const m = /New display: .*\(id=(\d+)\)/.exec(log[i]);
    if (m) return Number(m[1]);
  }
  return null;
}

// The launcher activity of pkg ("pkg/.Main"), or ''.
function component(out, pkg) {
  const line = String(out || '').split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith(pkg + '/'));
  return line && /^[\w.]+\/[\w.$]+$/.test(line) ? line : '';
}

// session: scrcpy Session (log, startApp); adb + serial: the phone's; maker: phone.info.maker.
async function startApp(session, { adb, serial, maker, app }) {
  const id = displayIdOf(session.log);
  if (id === null || !adb || !serial || !FREEFORM_MAKERS.test(maker || '') || !PKG.test(app || '')) return session.startApp(app);
  try {
    const r = await adb.shell(serial, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${app}`, { timeout: 5000 });
    const comp = component(r.out, app);
    if (!comp) return session.startApp(app);
    const s = await adb.shell(serial, `am start --display ${id} --windowingMode 1 -n ${comp}`, { timeout: 8000 });
    if (/Error|Exception|not found/i.test(`${s.out || ''}\n${s.err || ''}`)) return session.startApp(app);
  } catch (_) {
    session.startApp(app);
  }
}

module.exports = { startApp, displayIdOf, component };
