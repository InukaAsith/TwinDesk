// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Keyboard tab: typing follows the pointer. The Hotkey card (double-tap = mouse and keyboard back
// here; keyboard-only switching), then two direction cards; the directions are the
// same switches as on the Cursor tab. Behaviour: kvm.js and windows-helper.
'use strict';

UI.tab({
  id: 'keyboard',
  for: ['computer', 'android'], // iOS takes no mouse or keyboard from an app (shared/ui-kinds.js)
  order: 30,
  title: 'Keyboard',
  color: 'linear-gradient(#d1d1d6, #8e8e93)',
  desc: 'Type on whichever computer the pointer is on.',
  master: { get: (s) => s.kvm.keyboard, set: (v) => UI.api.setKvm({ keyboard: v }) },
  badge: (s) => (s.kvm.keyboard ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const t = (...args) => I18n.t(...args);
    const hotkey = UI.select(Object.entries(UI.HOTKEYS).map(([value, label]) => ({ value, label })), (v) => api.setKeys({ hotkey: v }));
    const hotkeyRow = UI.row(t('Hotkey'), t('Double-tap to turn cursor sharing on or off'), [hotkey]);
    // Cursor sharing off by its switch or the hotkey (kvm.linked) leaves kvm.mouse on: keyboard-only
    // switching needs the keyboard shared and only the cursor off, so turning it on swaps one for the other.
    let cursorOff = false;
    const switchSw = UI.switch((v) => api.setKvm(v && cursorOff ? { hotkeySwitch: true, mouse: false, shared: true } : { hotkeySwitch: v }), { label: t('Switch the keyboard with the hotkey') });
    const switchRow = UI.row(t('Switch the keyboard with the hotkey'), '', [switchSw], { literal: true });
    const swap = UI.switch((v) => api.setKeys({ swapCtrlCmd: v }), { label: t('Swap Ctrl and Command') });
    const otherHotkey = UI.row('', '', [], { literal: true });
    const swapRow = UI.row(t('⌘ works as Ctrl'), t('So ⌘C copies here'), [swap]);
    const shortcutsRow = UI.row(t('Shortcuts on {name}'), t('Ctrl works as ⌘, so Ctrl+C copies there'));
    const status = UI.inputStatus();
    const pair = UI.dirCards(
      { on: { get: (s) => s.kvm.beDriven, set: (v) => api.setKvm({ beDriven: v }) }, label: t('Type on {me} with {name}’s keyboard'), rows: [otherHotkey, swapRow] },
      { on: { get: (s) => s.kvm.driveOther, set: (v) => api.setKvm({ driveOther: v }) }, label: t('Type on {name} with {me}’s keyboard'), rows: [shortcutsRow] },
    );

    body.append(
      UI.card(t('Hotkey'), [hotkeyRow, switchRow], { cls: 'keep-on' }),
      pair.el,
      UI.card(t('Right now'), [status], { cls: 'keep-on' }),
    );

    return (s) => {
      const p = UI.peer(s);
      pair.update(s);
      status.update(s);
      hotkey.set(s.keys.hotkey);
      // Keyboard-only switching exists only while the pointer isn't shared (Cursor off, either way).
      cursorOff = !s.kvm.mouse || s.kvm.linked === false;
      switchSw.set(s.kvm.hotkeySwitch && !s.kvm.mouse);
      switchSw.disable(!cursorOff);
      switchRow.setHint(!cursorOff ? t('Only when Cursor is off') : t('Double-tap to type on {device} and back', { device: p.the }));
      otherHotkey.label.textContent = t('Hotkey on {device}', { device: p.the });
      otherHotkey.setHint(t('Set in TwinDesk on {device}', { device: p.the }));
      // Ctrl/Cmd swapping only between a Mac and a PC.
      swapRow.hidden = p.os !== 'mac';
      shortcutsRow.hidden = p.os !== 'mac';
      swap.set(s.keys.swapCtrlCmd);
    };
  },
});
