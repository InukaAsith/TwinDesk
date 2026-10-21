// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor tab: the layout (the grid of the devices: a device's edges lead to its neighbours on the grid,
// docs/mesh.md "Shared layout"), directions, edge resistance, speed, scrolling.
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

    // ---- the layout: a grid of tiles (docs/mesh.md, "Shared layout") ----
    // Every device is a tile; its edges lead to the nearest tile on its row or column. Click a tile and
    // then an empty place to move it there, or then another tile to swap the two. Each change goes through
    // setLayoutCell, so every computer shows the same grid.
    let picked = null; // the device id picked, waiting for a place or another tile
    let last = null; // the last state, to draw the grid again
    const layoutHint = UI.note('info', '');
    const gridEl = el('div', { class: 'layout-map' });
    const layoutCard = UI.card('Where the other computers are', [gridEl, layoutHint], { cls: 'keep-on' });

    const cellOf = (id) => (last && last.layout && last.layout.cells[id]) || null;

    function move(id, x, y) {
      api.setLayoutCell({ id, x, y });
    }

    function pick(id) {
      picked = id;
      if (last) drawLayout(last);
    }

    // A tile was clicked: it is picked; a picked tile clicked again is put down; with a tile already picked,
    // the two swap places.
    function onTile(id) {
      if (picked === id) return pick(null);
      if (!picked) return pick(id);
      const from = picked;
      const to = cellOf(id);
      pick(null);
      if (to) move(from, to.x, to.y);
    }

    // An empty place was clicked: the picked device moves there.
    function onPlace(x, y) {
      if (!picked) return;
      const id = picked;
      pick(null);
      move(id, x, y);
    }

    function tile(id, info) {
      const state = info.self ? 'This Mac' : info.connected ? 'Connected' : 'Not connected';
      return el('button', {
        class: 'lay-tile' + (info.self ? ' here' : '') + (info.connected || info.self ? '' : ' off') + (picked === id ? ' picked' : ''),
        attrs: { type: 'button', title: `${info.name} — ${state}` },
        onclick: () => onTile(id),
      }, [
        UI.osIcon(info.os),
        el('span', { class: 'lay-name', text: info.name }),
        el('span', { class: 'lay-state', text: state }),
      ]);
    }

    function place(x, y) {
      return el('button', {
        class: 'lay-place' + (picked ? ' target' : ''),
        attrs: { type: 'button', 'aria-label': 'Empty place' },
        onclick: () => onPlace(x, y),
      });
    }

    function drawLayout(s) {
      const lay = s && s.layout;
      if (!lay || !lay.grid) return;
      if (picked && !lay.cells[picked]) picked = null; // a device that is gone cannot be moved
      const people = new Map([[s.macId, { name: s.macName || 'This Mac', os: 'mac', connected: true, self: true }]]);
      for (const d of s.peers || []) {
        if (d && d.id) people.set(d.id, { name: d.name || d.id.slice(0, 8), os: d.os, connected: !!d.connected, self: false });
      }
      const at = new Map();
      for (const id of Object.keys(lay.cells)) at.set(`${lay.cells[id].x},${lay.cells[id].y}`, id);
      const g = lay.grid;
      gridEl.style.gridTemplateColumns = `repeat(${g.maxX - g.minX + 1}, minmax(96px, 1fr))`;
      const cells = [];
      for (let y = g.minY; y <= g.maxY; y++) {
        for (let x = g.minX; x <= g.maxX; x++) {
          const id = at.get(`${x},${y}`);
          cells.push(id ? tile(id, people.get(id) || { name: id.slice(0, 8), os: '', connected: false, self: false }) : place(x, y));
        }
      }
      gridEl.replaceChildren(...cells);
      layoutHint.set(picked
        ? 'Now click an empty place to move it there, or another device to swap places.'
        : 'Click a device, then an empty place to move it there, or another device to swap places.');
    }

    // A row whose label follows the other computer's name (UI.names fills it on render).
    const peerRow = (label, hint, controls) => {
      const r = UI.row(label, hint, controls);
      r.label.dataset.peer = label;
      return r;
    };

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
    let driven2 = null;
    body.append(
      status,
      UI.pair(
        UI.dir('m2w', [peerRow('Use {me}’s mouse and keyboard on {name}', 'Push the pointer past the edge', [drive]), viaRow]),
        UI.dir('w2m', [driven2 = peerRow('Use {name}’s mouse and keyboard on {me}', '', [driven])]),
      ),
      layoutCard,
      UI.card('Feel', [
        UI.row('Edge resistance', 'Push a little further to cross', [resistance]),
        peerRow('Pointer speed on {name}', '', [speed]),
        peerRow('Reverse scrolling from {name}', '', [reverse]),
        gestureRow,
      ]),
      UI.card('Not on the same network', [bleRow]),
    );

    return (s) => {
      const k = s.kvm;
      if (!k) return;
      const [kind, text] = UI.kvmStatus(s);
      status.className = `note ${kind}`;
      status.set(text);
      last = s;
      drawLayout(s);
      driven2.setHint('Double-tap the hotkey to take everything back');
      drive.set(k.driveOther);
      driven.set(k.beDriven);
      resistance.set(k.resistancePx);
      speed.set(k.speed);
      reverse.set(k.reverseScroll);
      gestures.set(k.gestures !== false);
      ble.set(k.ble !== false);
      viaRow.hidden = !UI.peer(s).phone;
      via.set(((s.phone || {}).bridge || {}).input || (((s.phone || {}).settings || {}).input === 'phone' ? 'phone' : 'adb'));
    };
  },
});
