// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor tab: where the PC is (layout picker), directions, edge resistance, speed, scrolling.
'use strict';

UI.tab({
  id: 'cursor',
  group: 'Input',
  order: 20,
  title: 'Cursor',
  desc: 'Move the pointer off the edge of the screen to go to the other computer.',
  color: 'linear-gradient(#ffb340, #ff9500)',
  // One switch: cursor sharing, the same one the hotkey's double-tap and the other
  // computer flip (kvm.link keeps both in step). Through Bluetooth it is Over Bluetooth (kvm.setShared).
  master: { get: (s) => !!(s.kvm && s.kvm.mouse && s.kvm.linked !== false && !(s.input && s.input.paused)), set: (v) => UI.api.setKvm(v ? { mouse: true, shared: true } : { shared: false }) },
  badge: (s) => (s.kvm && s.kvm.mouse && s.kvm.linked !== false && !(s.input && s.input.paused) ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const status = UI.note('info', '');

    let latestState = null;
    // Layout picker: the Mac in the middle, a slot on each side for the PC or Phone.
    const slots = {};
    let meLabel = null;
    const grid = el('div', { class: 'layout-grid' });
    const cell = (side) => {
      const b = el('button', { class: 'slot', title: `Put it ${side === 'top' ? 'above' : side === 'bottom' ? 'below' : `on the ${side}`}`, attrs: { 'aria-label': `Device ${side}` } });
      b.onclick = () => {
        if (!latestState) return;
        const k = latestState.kvm || {};
        const compSide = k.pcSide || 'right';
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
        else api.setKvm({ pcSide: side });
      };
      slots[side] = b;
      return b;
    };
    grid.append(
      el('span'), cell('top'), el('span'),
      cell('left'), el('div', { class: 'screen mac-screen' }, [meLabel = el('span', { text: 'This Mac' })]), cell('right'),
      el('span'), cell('bottom'), el('span'),
    );
    const layoutHint = el('div', { class: 'layout-hint' });

    const drive = UI.switch((v) => api.setKvm({ driveOther: v }), { label: 'Use here, control there' });
    const driven = UI.switch((v) => api.setKvm({ beDriven: v }), { label: 'Let it control this computer' });
    const resistance = UI.slider({ min: 0, max: 400, step: 10, format: (v) => `${v} px` }, (v) => api.setKvm({ resistancePx: v }));
    const speed = UI.slider({ min: 0.25, max: 4, step: 0.25, format: (v) => `${v.toFixed(2)}×` }, (v) => api.setKvm({ speed: v }));
    const reverse = UI.switch((v) => api.setKvm({ reverseScroll: v }), { label: 'Reverse scrolling' });
    const gestures = UI.switch((v) => api.setKvm({ gestures: v }), { label: 'Trackpad gestures' });
    const gestureRow = UI.row('Trackpad gestures', 'Pinch to zoom, swipe between desktops, Mission Control / Task View, back and forward — done the native way on {name}. The same on both', [gestures]);
    const ble = UI.switch((v) => api.setKvm({ ble: v }), { label: 'Over Bluetooth' });
    const bleRow = UI.row('Over Bluetooth', 'When {name} isn’t on this network and you’re connected through Bluetooth (slower). Off: nothing crosses until you’re on Wi-Fi again. The same on both', [ble]);

    // A phone as the peer: how the pointer and keys reach it (settings.phone.input, the phone's own toggle too).
    const via = UI.segmented([{ value: 'adb', label: 'ADB' }, { value: 'phone', label: 'Accessibility' }], (v) => api.setPhone({ input: v, inputPicked: true }));
    const viaRow = UI.row('Through', 'ADB: full control. Accessibility: TwinDesk on the phone taps and types itself, over Wi-Fi, Wi-Fi Direct or Bluetooth, no developer options', [via.el]);
    // A row whose label follows the other computer's name (UI.names fills it on render).
    const peerRow = (label, hint, controls) => {
      const r = UI.row(label, hint, controls);
      r.label.dataset.peer = label;
      return r;
    };
    let driven2 = null;
    body.append(
      status,
      UI.pair(
        UI.dir('m2w', [peerRow('Use {me}’s mouse and keyboard on {name}', 'Push the pointer past the edge', [drive]), viaRow]),
        UI.dir('w2m', [driven2 = peerRow('Use {name}’s mouse and keyboard on {me}', '', [driven])]),
      ),
      UI.card('Screen layout (Computers & Phones)', [el('div', { class: 'layout' }, [grid, layoutHint])]),
      UI.card('Feel', [
        UI.row('Edge resistance', 'Push a little further to cross', [resistance]),
        peerRow('Pointer speed on {name}', '', [speed]),
        peerRow('Reverse scrolling from {name}', '', [reverse]),
        gestureRow,
      ]),
      UI.card('Not on the same network', [bleRow]),
    );

    return (s) => {
      latestState = s;
      const k = s.kvm;
      if (!k) return;
      const p = UI.peer(s);
      const [kind, text] = UI.kvmStatus(s);
      status.className = `note ${kind}`;
      status.set(text);
      const compSide = k.pcSide || 'right';
      const edges = k.edges ? k.edges : {
        left: compSide === 'left' ? 'computer' : null,
        right: compSide === 'right' ? 'computer' : null,
        top: compSide === 'top' ? 'computer' : null,
        bottom: compSide === 'bottom' ? 'computer' : null,
      };
      const compName = p.name || 'Computer';
      const phoneName = (s.phone && (s.phone.name || (s.phone.info && s.phone.info.name))) || 'Phone';

      for (const [side, b] of Object.entries(slots)) {
        const target = edges[side];
        b.classList.toggle('on', target === 'computer');
        b.classList.toggle('phone-here', target === 'phone');
        b.textContent = target === 'computer' ? ('🖥️ ' + compName) : target === 'phone' ? ('📱 ' + phoneName) : '';
        b.title = target === 'computer' ? `${compName} on ${side}. Click to change or clear.`
          : target === 'phone' ? `${phoneName} on ${side}. Click to clear.`
          : `Assign ${compName} or ${phoneName} here`;
        meLabel.textContent = p.me;
      }
      const placed = [];
      if (edges.left) placed.push((edges.left === 'computer' ? compName : phoneName) + ' on left');
      if (edges.right) placed.push((edges.right === 'computer' ? compName : phoneName) + ' on right');
      if (edges.top) placed.push((edges.top === 'computer' ? compName : phoneName) + ' on top');
      if (edges.bottom) placed.push((edges.bottom === 'computer' ? compName : phoneName) + ' on bottom');
      layoutHint.textContent = placed.length
        ? placed.join(' · ') + '. Click any side to assign Computer, Phone, or None.'
        : 'Click a side to position your computer or phone around ' + p.me + '.';
      driven2.setHint('Double-tap the hotkey to take everything back');
      drive.set(k.driveOther);
      driven.set(k.beDriven);
      resistance.set(k.resistancePx);
      speed.set(k.speed);
      reverse.set(k.reverseScroll);
      gestures.set(k.gestures !== false);
      ble.set(k.ble !== false);
      viaRow.hidden = !p.phone;
      via.set(((s.phone || {}).bridge || {}).input || (((s.phone || {}).settings || {}).input === 'phone' ? 'phone' : 'adb'));
    };
  },
});
