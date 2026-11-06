// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Keyboard tab: keyboard sharing switch, the hotkey (double-tap = mouse and keyboard back here),
// keyboard-only switching with the hotkey, Ctrl <-> Cmd mapping (only between a Mac and a PC).
'use strict';

UI.tab({
  id: 'keyboard',
  group: 'Input',
  order: 30,
  hidden: (s) => !!s.activeWebDevice,
  title: I18n.t('Keyboard'),
  desc: I18n.t('Type on whichever computer the pointer is on.'),
  color: 'linear-gradient(#d1d1d6, #8e8e93)',
  master: { get: (s) => s.kvm && s.kvm.keyboard, set: (v) => UI.api.setKvm({ keyboard: v }) },
  badge: (s) => (s.kvm && s.kvm.keyboard ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const status = UI.note('info', '', { literal: true });
    const hotkey = UI.select(Object.entries(UI.HOTKEYS).map(([value, label]) => ({ value, label })), (v) => api.setKeys({ hotkey: v }));
    const hotkeyRow = UI.row(I18n.t('Hotkey'), I18n.t('Double-tap to turn cursor sharing on or off'), [hotkey]);
    // Cursor sharing off by its switch or the hotkey (kvm.linked) leaves kvm.mouse on: keyboard-only
    // switching needs the keyboard shared and only the cursor off, so turning it on swaps one for the other.
    let cursorOff = false;
    const switchSw = UI.switch((v) => api.setKvm(v && cursorOff ? { hotkeySwitch: true, mouse: false, shared: true } : { hotkeySwitch: v }), { label: I18n.t('Switch the keyboard with the hotkey') });
    const switchRow = UI.row(I18n.t('Switch the keyboard with the hotkey'), '', [switchSw], { literalHint: true });
    const swap = UI.switch((v) => api.setKeys({ swapCtrlCmd: v }), { label: I18n.t('Swap Ctrl and Command') });
    const shortcutsRow = UI.row(I18n.t('Shortcuts on {name}'), I18n.t('⌘ works as Ctrl, so ⌘C copies there'));
    const swapRow = UI.row(I18n.t('Ctrl works as ⌘'), I18n.t('So Ctrl+C copies here'), [swap]);
    const otherHotkey = UI.row(I18n.t('Hotkey on {name}'), '', [], { literalHint: true });

    body.append(
      status,
      UI.card(I18n.t('Hotkey'), [hotkeyRow, switchRow], { cls: 'keep-on' }),
      UI.pair(UI.dir('m2w', [shortcutsRow]), UI.dir('w2m', [otherHotkey, swapRow])),
    );

    return (s) => {
      if (!s.kvm) return;
      const p = UI.peer(s);
      const [kind, text] = UI.kvmStatus(s);
      status.className = `note ${kind}`;
      status.set(text);
      hotkey.set((s.keys && s.keys.hotkey) || 'AltRight');
      // Keyboard-only switching exists only while the pointer isn't shared (Cursor off, either way).
      cursorOff = !s.kvm.mouse || s.kvm.linked === false;
      switchSw.set(s.kvm.hotkeySwitch && !s.kvm.mouse);
      switchSw.disable(!cursorOff);
      switchRow.setHint(!cursorOff ? I18n.t('Only when Cursor is off') : I18n.t('Double-tap to type on {device} and back', { device: p.name }));
      // Ctrl/Cmd swapping only between a Mac and a PC or Linux.
      shortcutsRow.hidden = p.same;
      swapRow.hidden = p.same;
      swap.set(s.keys && s.keys.swapCtrlCmd);
      otherHotkey.setHint(I18n.t('Set in TwinDesk on {device}', { device: p.name }));
    };
  },
});
