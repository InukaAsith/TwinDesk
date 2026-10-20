// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor tab: share the pointer across the screen edge. The two direction cards, the layout (the grid
// of the paired devices: a device's edges lead to its neighbours on the grid, docs/mesh.md) and the
// live state. Behaviour: kvm.js and windows-helper.
'use strict';

UI.tab({
  id: 'cursor',
  order: 20,
  title: 'Cursor',
  color: 'linear-gradient(#ffb340, #ff9500)',
  desc: 'Move the pointer off the edge of the screen to go to the other computer.',
  // One switch: cursor sharing, the same one the hotkey's double-tap and the other
  // computer flip (kvm.link keeps both in step); on also turns the mouse on.
  master: { get: (s) => s.kvm.mouse && s.kvm.linked, set: (v) => UI.api.setKvm(v ? { mouse: true, linked: true } : { linked: false }) },
  badge: (s) => (s.kvm.mouse && s.kvm.linked ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setKvm(partial);

    const speed = UI.slider({ min: 0.25, max: 3, step: 0.05, format: (v) => v.toFixed(2) + '×' }, (v) => set({ speed: v }));
    const reverse = UI.switch((v) => set({ reverseScroll: v }), { label: 'Reverse scrolling' });
    const gestures = UI.switch((v) => set({ gestures: v }), { label: 'Trackpad gestures' });
    const gestureRow = UI.row('Trackpad gestures', 'Pinch to zoom, swipe between desktops, Task View / Mission Control, back and forward — done the native way on {name}. The same on both', [gestures]);
    const resistance = UI.slider({ min: 0, max: 400, step: 10, format: (v) => (v ? v + ' px' : 'None') }, (v) => set({ resistancePx: v }));
    const pair = UI.dirCards(
      { on: { get: (s) => s.kvm.beDriven, set: (v) => set({ beDriven: v }) }, label: 'Use {name}’s mouse and keyboard on {me}', hint: 'Push the pointer past the edge there', rows: [
        UI.row('Pointer speed here', '', [speed]),
        UI.row('Reverse scrolling', '', [reverse]),
      ] },
      { on: { get: (s) => s.kvm.driveOther, set: (v) => set({ driveOther: v }) }, label: 'Use {me}’s mouse and keyboard on {name}', hint: 'Push the pointer past the edge', rows: [
        UI.row('Edge resistance', 'Push a little further to cross', [resistance]),
      ] },
    );

    // ---- the layout: a grid of tiles (docs/mesh.md, "Shared layout") ----
    // Every paired device is a tile; its edges lead to the nearest tile on its row or column. Click a tile
    // and then an empty place to move it there, or then another tile to swap the two. Each change goes
    // through setLayoutCell, so every computer shows the same grid.
    let picked = null; // the device id picked, waiting for a place or another tile
    let last = null; // the last state, to draw the grid again
    const layoutHint = UI.note('info', '');
    const gridEl = UI.el('div', { class: 'layout-grid' });
    const layoutCard = UI.card('Layout', [gridEl, layoutHint], { cls: 'keep-on' });

    const cellOf = (id) => (last && last.layout && last.layout.cells[id]) || null;

    function move(id, x, y) {
      api.setLayoutCell(id, x, y).then((ok) => {
        if (ok === false) layoutHint.set('That did not move.');
      });
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
      const state = info.self ? 'This PC' : info.connected ? 'Connected' : 'Not connected';
      return UI.el('button', {
        class: 'lay-tile' + (info.self ? ' here' : '') + (info.connected || info.self ? '' : ' off') + (picked === id ? ' picked' : ''),
        attrs: { type: 'button', title: info.name + ' — ' + state },
        onclick: () => onTile(id),
      }, [
        UI.osIcon(info.os),
        UI.el('span', { class: 'lay-name', text: info.name }),
        UI.el('span', { class: 'lay-state', text: state }),
      ]);
    }

    function place(x, y) {
      return UI.el('button', {
        class: 'lay-place' + (picked ? ' target' : ''),
        attrs: { type: 'button', 'aria-label': 'Empty place' },
        onclick: () => onPlace(x, y),
      });
    }

    function drawLayout(s) {
      const lay = s && s.layout;
      if (!lay || !lay.grid || !s.device) return;
      if (picked && !lay.cells[picked]) picked = null; // a device that is gone cannot be moved
      const people = new Map([[s.device.id, { name: s.device.name || 'This PC', os: 'win', connected: true, self: true }]]);
      for (const d of s.peers || []) {
        if (d && d.id) people.set(d.id, { name: d.name || d.id.slice(0, 8), os: d.os, connected: !!d.connected, self: false });
      }
      const at = new Map();
      for (const id of Object.keys(lay.cells)) at.set(lay.cells[id].x + ',' + lay.cells[id].y, id);
      const g = lay.grid;
      gridEl.style.gridTemplateColumns = `repeat(${g.maxX - g.minX + 1}, minmax(96px, 1fr))`;
      const cells = [];
      for (let y = g.minY; y <= g.maxY; y++) {
        for (let x = g.minX; x <= g.maxX; x++) {
          const id = at.get(x + ',' + y);
          cells.push(id ? tile(id, people.get(id) || { name: id.slice(0, 8), os: '', connected: false, self: false }) : place(x, y));
        }
      }
      gridEl.replaceChildren(...cells);
      layoutHint.set(picked
        ? 'Now click an empty place to move it there, or another device to swap places.'
        : 'Click a device, then an empty place to move it there, or another device to swap places.');
    }

    const status = UI.inputStatus();

    body.append(
      pair.el,
      UI.card('Feel', [gestureRow]),
      UI.card('Right now', [status], { cls: 'keep-on' }),
      layoutCard,
    );

    function render(s) {
      last = s;
      pair.update(s);
      status.update(s);
      speed.set(s.kvm.speed);
      reverse.set(s.kvm.reverseScroll);
      gestures.set(s.kvm.gestures !== false);
      resistance.set(s.kvm.resistancePx);
      drawLayout(s);
    }
    return render;
  },
});
