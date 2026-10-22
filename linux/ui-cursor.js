// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor tab: share the pointer across the screen edge. Two direction cards, the
// layout (pick where the other computer is; either side can change it) and the live state below. Behaviour: kvm.js and windows-helper.
'use strict';

UI.tab({
  id: 'cursor',
  order: 20,
  title: 'Cursor',
  color: 'linear-gradient(#ffb340, #ff9500)',
  desc: 'Move the pointer off the edge of the screen to go to the other computer.',
  // One switch: cursor sharing, the same one the hotkey's double-tap and the other
  // computer flip (kvm.link keeps both in step); on also turns the mouse on. Through Bluetooth
  // it is Over Bluetooth (kvm.setShared).
  master: { get: (s) => s.kvm.mouse && s.kvm.linked && !s.kvmState.paused, set: (v) => UI.api.setKvm(v ? { mouse: true, shared: true } : { shared: false }) },
  badge: (s) => (s.kvm.mouse && s.kvm.linked && !s.kvmState.paused ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setKvm(partial);
    // kvm.layout says where the PC is seen from the Mac; the Mac is on the opposite side of the PC.
    const MAC_SIDE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
    const CELL = { top: 1, left: 3, right: 5, bottom: 7 };

    const speed = UI.slider({ min: 0.25, max: 3, step: 0.05, format: (v) => v.toFixed(2) + '×' }, (v) => set({ speed: v }));
    const reverse = UI.switch((v) => set({ reverseScroll: v }), { label: 'Reverse scrolling' });
    const gestures = UI.switch((v) => set({ gestures: v }), { label: 'Trackpad gestures' });
    const gestureRow = UI.row('Trackpad gestures', 'Pinch to zoom, swipe between desktops, Task View / Mission Control, back and forward — done the native way on {name}. The same on both', [gestures]);
    const ble = UI.switch((v) => set({ ble: v }), { label: 'Over Bluetooth' });
    const bleRow = UI.row('Over Bluetooth', 'When {name} isn’t on this network and you’re connected through Bluetooth (slower). Off: nothing crosses until you’re on Wi-Fi again. The same on both', [ble]);
    // A phone as the peer: how the pointer and keys reach it (settings.phone.input, the phone's own toggle too).
    const via = UI.segmented([{ value: 'adb', label: 'ADB' }, { value: 'phone', label: 'Accessibility' }], (v) => api.setPhone({ input: v, inputPicked: true }));
    const viaRow = UI.row('Through', 'ADB: full control. Accessibility: TwinDesk on the phone taps and types itself, over Wi-Fi, Wi-Fi Direct or Bluetooth, no developer options', [via.el]);
    const resistance = UI.slider({ min: 0, max: 400, step: 10, format: (v) => (v ? v + ' px' : 'None') }, (v) => set({ resistancePx: v }));
    const pair = UI.dirCards(
      { on: { get: (s) => s.kvm.beDriven, set: (v) => set({ beDriven: v }) }, label: 'Use {name}’s mouse and keyboard on {me}', hint: 'Push the pointer past the edge there', rows: [
        UI.row('Pointer speed here', '', [speed]),
        UI.row('Reverse scrolling', '', [reverse]),
      ] },
      { on: { get: (s) => s.kvm.driveOther, set: (v) => set({ driveOther: v }) }, label: 'Use {me}’s mouse and keyboard on {name}', hint: 'Push the pointer past the edge', rows: [
        UI.row('Edge resistance', 'Push a little further to cross', [resistance]),
        viaRow,
      ] },
    );

    let latestState = null;
    const cells = [];
    const grid = el('div', { class: 'layout-grid' });
    const SIDE_OF = { 1: 'top', 3: 'left', 5: 'right', 7: 'bottom' };
    for (let i = 0; i < 9; i++) {
      const c = el('div', { class: i === 4 ? 'screen pc-screen' : '', text: i === 4 ? '{me}' : '' });
      if (SIDE_OF[i]) {
        const side = SIDE_OF[i];
        c.onclick = () => {
          if (!latestState) return;
          const k = latestState.kvm || {};
          const compSide = k.pcSide ? MAC_SIDE[k.pcSide] : 'right';
          const edges = k.edges ? { ...k.edges } : {
            left: compSide === 'left' ? 'computer' : null,
            right: compSide === 'right' ? 'computer' : null,
            top: compSide === 'top' ? 'computer' : null,
            bottom: compSide === 'bottom' ? 'computer' : null,
          };
          const cur = edges[side] || null;
          const hasPhone = !!(latestState.phone && (latestState.phone.connected || latestState.phone.bridge || latestState.phone.settings || latestState.phone.info));
          let next = null;
          if (!cur) {
            const hasComp = Object.values(edges).includes('computer');
            if (!hasComp) next = 'computer';
            else if (hasPhone) next = 'phone';
            else next = 'computer';
          } else if (cur === 'computer') {
            next = hasPhone ? 'phone' : null;
          } else if (cur === 'phone') {
            next = null;
          }
          if (api.setEdge) api.setEdge({ side, target: next });
          else api.setLayout(side);
        };
      }
      cells.push(c);
      grid.append(c);
    }
    const layoutHint = el('div', { class: 'layout-hint' });
    const status = UI.inputStatus();

    body.append(
      pair.el,
      UI.card('Feel', [gestureRow]),
      UI.card('Not on the same network', [bleRow]),
      UI.card('Right now', [status], { cls: 'keep-on' }),
      el('div', { class: 'card-title', text: 'Screen layout (Computers & Phones)' }),
      el('div', { class: 'card layout' }, [grid, layoutHint]),
    );

    return (s) => {
      latestState = s;
      const k = s.kvm;
      pair.update(s);
      status.update(s);
      speed.set(k.speed);
      reverse.set(k.reverseScroll);
      gestures.set(k.gestures !== false);
      resistance.set(k.resistancePx);
      ble.set(k.ble !== false);
      viaRow.hidden = !UI.peer(s).phone;
      via.set(((s.phone || {}).bridge || {}).input || (((s.phone || {}).settings || {}).input === 'phone' ? 'phone' : 'adb'));
      const p = UI.peer(s);
      const compSide = k.pcSide ? MAC_SIDE[k.pcSide] : 'right';
      const edges = k.edges ? k.edges : {
        left: compSide === 'left' ? 'computer' : null,
        right: compSide === 'right' ? 'computer' : null,
        top: compSide === 'top' ? 'computer' : null,
        bottom: compSide === 'bottom' ? 'computer' : null,
      };
      const compName = p.them || (p.os === 'mac' ? 'Mac' : 'Computer');
      const phoneName = (s.phone && (s.phone.name || (s.phone.info && s.phone.info.name))) || 'Phone';

      cells.forEach((c, i) => {
        if (i === 4) return;
        const side = SIDE_OF[i];
        if (!side) return;
        const target = edges[side];
        if (target === 'computer') {
          c.className = 'cell mac-here';
          c.textContent = '🖥️ ' + compName;
          c.title = compName + ' on ' + side + '. Click to change or clear.';
        } else if (target === 'phone') {
          c.className = 'cell phone-here';
          c.textContent = '📱 ' + phoneName;
          c.title = phoneName + ' on ' + side + '. Click to clear.';
        } else {
          c.className = 'cell';
          c.textContent = '';
          c.title = 'Assign ' + compName + ' or ' + phoneName + ' here';
        }
      });
      const placed = [];
      if (edges.left) placed.push((edges.left === 'computer' ? compName : phoneName) + ' on left');
      if (edges.right) placed.push((edges.right === 'computer' ? compName : phoneName) + ' on right');
      if (edges.top) placed.push((edges.top === 'computer' ? compName : phoneName) + ' on top');
      if (edges.bottom) placed.push((edges.bottom === 'computer' ? compName : phoneName) + ' on bottom');
      layoutHint.textContent = placed.length
        ? placed.join(' · ') + '. Click any side to assign Computer, Phone, or None.'
        : 'Click a side to position your computer or phone around {me}.';
    };
  },
});
