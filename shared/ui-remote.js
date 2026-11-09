// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Remote tab (Mac, PC and Linux; with a phone): the phone's Remote page — a touchpad and keyboard,
// or a gamepad whose buttons press keys — moves this computer's pointer, clicks, scrolls and types
// (shared/phone-remote.js). Its switch at the top lets it, on until turned off; it's taken only
// while this computer's own mouse is at home (not on the phone or another computer: Cursor).
// Real gamepad: the gamepad page as a real controller here (an Xbox 360 controller on Windows, a
// uinput gamepad on Linux), its driver installed the first time it's turned on; the Mac says why
// it can't and points to the phone's As a Bluetooth gamepad.
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

UI.tab({
  id: 'remote',
  group: 'Input',
  order: 28,
  title: tr('Remote'),
  icon: 'remote',
  color: 'linear-gradient(#bf5af2, #8944ab)',
  desc: tr('Use the phone as this computer’s touchpad, keyboard or gamepad.'),
  for: ['android', 'ios'], // a phone's: Android, iPhone or iPad (shared/ui-kinds.js)
  badge: (s) => (s.remote && s.remote.using ? 'on' : ''),
  master: {
    get: (s) => !!(s.remote && s.remote.allow),
    set: (v) => UI.api.setRemote({ allow: v }),
    disabled: (s) => !s.remote,
  },
  build(body) {
    const status = UI.row(tr('Now'), '');
    const how = UI.row(tr('On {name}'), tr('Open TwinDesk › Remote there, then Touchpad and keyboard or Gamepad. Its speed, tap to click and the gamepad’s keys are set there'));
    const card = UI.card(tr('{name} as a remote'), [status, how]);
    const note = UI.note('warn', '');
    const padSwitch = UI.switch((v) => UI.api.setRemote({ pad: v }), { label: tr('Real gamepad') });
    const padRow = UI.row(tr('Real gamepad'), '', [padSwitch]);
    const padNote = UI.note('info', '');
    const padCard = UI.card(tr('Gamepad'), [padRow, padNote]);
    body.append(note, card, padCard);
    return (s) => {
      const r = s.remote || {};
      const p = r.pad || {};
      padSwitch.set(p.on);
      padSwitch.disable(!p.supported || !!p.busy);
      padRow.setHint(!p.supported ? tr('Not on this computer')
        : p.busy ? tr(p.busy)
          : !p.on ? tr('Off: the gamepad page’s sticks and buttons press keys (WASD, the mouse), as set on {name}')
            : p.live ? p.name ? tr('On: {name}’s gamepad page is a game controller here ({controller})', { controller: p.name }) : tr('On: {name}’s gamepad page is a game controller here')
              : tr('On: ready when {name} is connected'));
      padNote.set(tr(p.message || ''));
      status.setHint(!r.allow ? tr('Off: {name}’s Remote page can’t move or type here')
        : r.why ? tr(r.why)
          : r.using ? tr('In use: {name} is moving the pointer or typing here')
            : r.opened ? tr('{name}’s Remote page is open and ready')
              : tr('Ready: open the Remote page on {name}'));
      // On, but not taken now (the mouse is on another device).
      note.set(r.allow && r.why ? tr(r.why) : '');
    };
  },
});

})();
