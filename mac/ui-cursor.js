// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor tab: where the other computer is (the crossing map, shared/kvm-map-ui.js), directions,
// edge resistance, speed, scrolling.
'use strict';

UI.tab({
  id: 'cursor',
  group: 'Input',
  order: 20,
  hidden: (s) => !!s.activeWebDevice,
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

    // The crossing map: both computers' monitors; drag the other one where it is on the desk.
    const map = KvmMapUI.create({ onMove: (side, along) => api.moveKvm({ side, along }), onIdentify: () => api.identifyDisplays() });

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
    const via = UI.segmented([{ value: 'auto', label: I18n.t('Auto') }, { value: 'adb', label: I18n.t('Full (ADB)') }, { value: 'phone', label: I18n.t('Limited (Accessibility)') }],
      (v) => api.setPhone(v === 'auto' ? { input: 'adb', inputPicked: false } : { input: v, inputPicked: true }));
    // With a phone: its own card on top, with the way to its wireless debugging (Connection).
    const adbBtn = UI.button(I18n.t('Wireless Debugging'), () => UI.go('connection'), 'small');
    const viaRow = UI.row(I18n.t('Control the phone with'), '', [via.el, adbBtn]);
    const viaCard = UI.card(I18n.t('Phone'), [viaRow]);
    // A row whose label follows the other computer's name (UI.names fills it on render).
    const peerRow = (label, hint, controls) => {
      const r = UI.row(label, hint, controls);
      r.label.dataset.peer = label;
      return r;
    };
    let driven2 = null;
    let speedRow = null;
    body.append(
      status,
      viaCard,
      UI.pair(
        UI.dir('m2w', [peerRow(I18n.t('Use {me}’s mouse and keyboard on {name}'), I18n.t('Push the pointer past the edge'), [drive])]),
        UI.dir('w2m', [driven2 = peerRow(I18n.t('Use {name}’s mouse and keyboard on {me}'), '', [driven])]),
      ),
      lock.el,
      UI.card(I18n.t('Where the other computer is'), [map.el]),
      UI.card(I18n.t('Feel'), [
        UI.row(I18n.t('Edge resistance'), I18n.t('Push a little further to cross'), [resistance]),
        speedRow = peerRow(I18n.t('Pointer speed here'), '', [speed]),
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
      const p = UI.peer(s);
      const [kind, text] = UI.kvmStatus(s);
      status.className = `note ${kind}`;
      status.set(text);
      lock.update(s);
      const m = (s.input && s.input.map) || { mine: [], theirs: [], along: null };
      map.update({ mine: m.mine, theirs: m.theirs, side: k.pcSide, along: m.along, me: p.me, them: p.Name });
      driven2.setHint(I18n.t('Double-tap the hotkey to take everything back'));
      drive.set(k.driveOther);
      driven.set(k.beDriven);
      resistance.set(k.resistancePx);
      speed.set(k.speed);
      // A computer's mouse here is sped up by it; with a phone, it's this Mac's pointer there (phone-bridge.js).
      speedRow.label.dataset.peer = UI.isPhone(s) ? I18n.t('Pointer speed on {name}') : I18n.t('Pointer speed here');
      speedRow.label.textContent = UI.fill(speedRow.label.dataset.peer);
      reverse.set(k.reverseScroll);
      gestures.set(k.gestures !== false);
      syncPads.set(k.syncPads === true);
      shake.set(k.shakeHome !== false);
      ble.set(k.ble !== false);
      viaCard.hidden = !p.phone;
      const br = (s.phone || {}).bridge || {};
      via.set(br.inputMode || (((s.phone || {}).settings || {}).input === 'phone' ? 'phone' : 'adb'));
      adbBtn.hidden = br.state === 'ready';
      viaRow.setHint(br.inputMode === 'auto' ? (br.state === 'ready' ? I18n.t('Auto: Full (ADB), wireless debugging is ready') : I18n.t('Auto: Limited until wireless debugging is set up'))
        : br.input === 'phone' ? I18n.t('Limited: TwinDesk on the phone taps and types (its Accessibility service). Works over Wi-Fi, Wi-Fi Direct and Bluetooth, no developer options')
          : I18n.t('Full (ADB): full control through wireless debugging') + (br.state === 'ready' ? '' : I18n.t(' (not set up yet)')));
    };
  },
});
