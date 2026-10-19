// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cursor tab: share the pointer across the screen edge. The two direction cards, the layout (which
// paired device is behind each edge of this screen; each edge can lead to a different one) and the
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
    const EDGES = [['top', 'Top edge'], ['right', 'Right edge'], ['bottom', 'Bottom edge'], ['left', 'Left edge']];

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

    // The device behind each edge of this screen. One device sits on one edge; an edge holds one device.
    const refused = UI.note('info', '');
    let last = null; // the last state, to put a refused choice back
    const edgeRows = EDGES.map(([side, label]) => {
      const sel = UI.select([{ value: '', label: 'None' }], (v) => {
        api.setEdge(side, v || null).then((ok) => {
          refused.set(ok === false ? 'That edge already leads to another device. Set it to None first.' : '');
          if (last) render(last);
        });
      });
      return { side, sel, row: UI.row(label, '', [sel.el]) };
    });
    const layout = UI.card('Layout', [...edgeRows.map((r) => r.row), refused], { cls: 'keep-on' });

    const status = UI.inputStatus();

    body.append(
      pair.el,
      UI.card('Feel', [gestureRow]),
      UI.card('Right now', [status], { cls: 'keep-on' }),
      layout,
    );

    // Each edge's choices: None, then every paired device; a connected one says so.
    function render(s) {
      last = s;
      const k = s.kvm;
      pair.update(s);
      status.update(s);
      speed.set(k.speed);
      reverse.set(k.reverseScroll);
      gestures.set(k.gestures !== false);
      resistance.set(k.resistancePx);
      const devices = (s.peers || []).filter((d) => d && d.id);
      const options = [{ value: '', label: 'None' }].concat(devices.map((d) => ({ value: d.id, label: d.name + (d.connected ? '' : ' (not connected)') })));
      for (const r of edgeRows) {
        const id = (k.edges && k.edges[r.side]) || '';
        const d = devices.find((x) => x.id === id);
        r.sel.options(options);
        r.sel.set(id);
        r.row.setHint(!id ? 'Nothing crosses this edge' : d && d.connected ? 'Connected' : 'Not connected');
      }
    }
    return render;
  },
});
