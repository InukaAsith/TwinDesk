// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Cursor tab: directions, edge resistance, speed, scrolling. Which device each edge leads to is the
// layout in the Multi-device tab (ui-multi.js, docs/mesh.md "Shared layout").
'use strict';

UI.tab({
  id: 'cursor',
  group: 'Input',
  order: 20,
  for: ['computer', 'android'], // iOS takes no mouse or keyboard from an app (shared/ui-kinds.js)
  title: I18n.t('Mouse'),
  desc: I18n.t('Move the pointer off the edge of the screen to go to the other computer.'),
  color: 'linear-gradient(#ffb340, #ff9500)',
  // One switch: cursor sharing, the same one the hotkey's double-tap and the other
  // computer flip (kvm.link keeps both in step). Through Bluetooth it is Over Bluetooth (kvm.setShared).
  master: { get: (s) => !!(s.kvm && s.kvm.mouse && s.kvm.linked !== false && !(s.input && s.input.paused)), set: (v) => UI.api.setKvm(v ? { mouse: true, shared: true } : { shared: false }) },
  badge: (s) => (s.kvm && s.kvm.mouse && s.kvm.linked !== false && !(s.input && s.input.paused) ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const status = UI.note('info', '', { literal: true });
    const lock = UI.cursorLock();

    // A row whose label follows the other computer's name (UI.names fills it on render).
    const peerRow = (label, hint, controls) => {
      const r = UI.row(label, hint, controls);
      r.label.dataset.peer = label;
      return r;
    };

    const drive = UI.switch((v) => api.setKvm({ driveOther: v }), { label: I18n.t('Use here, control there') });
    const driven = UI.switch((v) => api.setKvm({ beDriven: v }), { label: I18n.t('Let it control this computer') });
    const resistance = UI.slider({ min: 0, max: 400, step: 10, format: (v) => `${v} px` }, (v) => api.setKvm({ resistancePx: v }));
    const speed = UI.slider({ min: 0.25, max: 4, step: 0.25, format: (v) => `${v.toFixed(2)}×` }, (v) => api.setKvm({ speed: v }));
    const reverse = UI.switch((v) => api.setKvm({ reverseScroll: v }), { label: I18n.t('Reverse scrolling') });
    const gestures = UI.switch((v) => api.setKvm({ gestures: v }), { label: I18n.t('Trackpad gestures') });
    const gestureRow = UI.row(I18n.t('Trackpad gestures'), I18n.t('Pinch to zoom, swipe between desktops, Mission Control / Task View, back and forward — done the native way on {name}. The same on both'), [gestures]);
    const syncPads = UI.switch((v) => api.setKvm({ syncPads: v }), { label: I18n.t('Sync touchpads') });
    const syncRow = UI.row(I18n.t('Sync touchpads'), I18n.t('On: every computer’s mouse and trackpad move the one pointer, wherever it is. Off: using a computer’s own trackpad takes its pointer back. The same on both'), [syncPads]);
    const shake = UI.switch((v) => api.setKvm({ shakeHome: v }), { label: I18n.t('Shake to bring the pointer back') });
    const shakeRow = UI.row(I18n.t('Shake to bring the pointer back'), I18n.t('While you use another computer, shake this computer’s mouse or trackpad left and right: the pointer comes back here'), [shake]);
    const ble = UI.switch((v) => api.setKvm({ ble: v }), { label: I18n.t('Over Bluetooth') });
    const bleRow = UI.row(I18n.t('Over Bluetooth'), I18n.t('When {name} isn’t on this network and you’re connected through Bluetooth (slower). Off: nothing crosses until you’re on Wi-Fi again. The same on both'), [ble]);

    // A phone as the peer: how the pointer and keys reach it (settings.phone.input, the phone's own toggle too).
    const via = UI.segmented([{ value: 'adb', label: 'ADB' }, { value: 'phone', label: I18n.t('Accessibility') }], (v) => api.setPhone({ input: v, inputPicked: true }));
    const viaRow = UI.row(I18n.t('Through'), I18n.t('ADB: full control. Accessibility: TwinDesk on the phone taps and types itself, over Wi-Fi, Wi-Fi Direct or Bluetooth, no developer options'), [via.el]);
    let driven2 = null;
    body.append(
      status,
      UI.pair(
        UI.dir('m2w', [peerRow(I18n.t('Use {me}’s mouse and keyboard on {name}'), I18n.t('Push the pointer past the edge'), [drive]), viaRow]),
        UI.dir('w2m', [driven2 = peerRow(I18n.t('Use {name}’s mouse and keyboard on {me}'), '', [driven])]),
      ),
      lock.el,
      UI.note('info', I18n.t('Which device each edge of the screen leads to: Multi-device › Layout.')),
      UI.card(I18n.t('Feel'), [
        UI.row(I18n.t('Edge resistance'), I18n.t('Push a little further to cross'), [resistance]),
        UI.row(I18n.t('Pointer speed here'), I18n.t('Another computer’s mouse on this Mac, and this Mac’s on a phone'), [speed]),
        peerRow(I18n.t('Reverse scrolling from {name}'), '', [reverse]),
        gestureRow,
        syncRow,
        shakeRow,
      ]),
      UI.card(I18n.t('Not on the same network'), [bleRow]),
    );

    return (s) => {
      const k = s.kvm;
      if (!k) return;
      const [kind, text] = UI.kvmStatus(s);
      status.className = `note ${kind}`;
      status.set(text);
      lock.update(s);
      driven2.setHint(I18n.t('Double-tap the hotkey to take everything back'));
      drive.set(k.driveOther);
      driven.set(k.beDriven);
      resistance.set(k.resistancePx);
      speed.set(k.speed);
      reverse.set(k.reverseScroll);
      gestures.set(k.gestures !== false);
      syncPads.set(k.syncPads === true);
      shake.set(k.shakeHome !== false);
      ble.set(k.ble !== false);
      viaRow.hidden = !UI.peer(s).phone;
      via.set(((s.phone || {}).bridge || {}).input || (((s.phone || {}).settings || {}).input === 'phone' ? 'phone' : 'adb'));
    };
  },
});
