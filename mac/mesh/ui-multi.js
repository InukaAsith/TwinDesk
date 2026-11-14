// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Multi-device tab with it on (docs/multi-device.md): what only several devices need, in one place.
// Turn off (TwinDesk restarts one to one), where the devices sit (the shared layout's grid, docs/mesh.md
// "Shared layout"), and Join every device automatically (docs/mesh.md "Joining everyone").
'use strict';

UI.tab({
  id: 'multi',
  order: 95,
  title: I18n.t('Multi-device'),
  heading: I18n.t('Multi-device · Mesh mode'),
  desc: I18n.t('Several computers and phones connected at once'),
  color: 'linear-gradient(#5e5ce6, #3634a3)',
  bottom: true,
  build(body) {
    const { el, api } = UI;
    const turnOff = UI.button(I18n.t('Turn off'), () => {
      turnOff.disabled = true;
      turnOff.textContent = I18n.t('Restarting…');
      api.setMulti(false);
    }, 'small');

    // ---- the layout: the monitor map (shared/ui-monitor-map.js, docs/mesh.md "Shared layout") ----
    // Every device's monitors where they sit on the desk; drag one to move it. Each change goes through
    // moveOnMap, so every device shows the same map, and the pointer crosses only where monitors touch.
    let last = null; // the last state
    const layoutHint = UI.note('info', '');
    const reachNote = UI.note('warn', '', { literal: true }); // the devices the pointer can't get to from here, and why
    const map = MonitorMap.create({ move: (id, x, y, snap) => api.moveOnMap({ id, x, y, snap }) });
    const resetBtn = UI.button(I18n.t('Line up again'), () => api.resetMap(), 'small');
    const actions = UI.el('div', { class: 'mm-actions' }, [resetBtn]);
    // An offline computer in the way: the pointer goes on to what is past it, or stops (a red line).
    const skipSw = UI.switch((v) => api.setMapSkip(v), { label: I18n.t('Skip computers that are not connected') });
    const skipRow = UI.row(I18n.t('Skip computers that are not connected'), '', [skipSw]);

    function drawLayout(s) {
      const lay = s && s.layout;
      if (!lay || !lay.map) return;
      const people = new Map([[s.macId, { name: s.macName || I18n.t('This Mac'), os: 'mac', connected: true, self: true }]]);
      for (const d of s.peers || []) {
        if (d && d.id) people.set(d.id, { name: d.name || d.id.slice(0, 8), os: d.os, connected: !!d.connected, self: false, via: d.state === 'via' });
      }
      map.draw(lay.map, people, s.macId);
      resetBtn.hidden = !lay.map.arranged; // only once someone moved a device on the map
      const skip = lay.map.skip !== false;
      skipSw.set(skip);
      skipRow.setHint(skip ? I18n.t('On: the pointer goes past a computer that is not connected, to the device on its far side')
        : I18n.t('Off: the pointer stops at a computer that is not connected (a red line)'));
      const reach = lay.reach || {};
      const red = Object.keys(reach).filter((id) => reach[id] === 'blocked' && (people.get(id) || {}).via);
      const behind = Object.values(reach).includes('behind');
      const autoJoin = (s.mesh || {}).autoJoin === true;
      reachNote.set(red.length ? I18n.t(behind
        ? autoJoin ? '{devices} are not connected to this Mac, so the pointer stops before them and does not get to the devices past them. Pair them with this Mac.' : '{devices} are not connected to this Mac, so the pointer stops before them and does not get to the devices past them. Pair them with this Mac, or turn on Join every device automatically.'
        : autoJoin ? '{devices} are not connected to this Mac, so the pointer stops before them. Pair them with this Mac.' : '{devices} are not connected to this Mac, so the pointer stops before them. Pair them with this Mac, or turn on Join every device automatically.', { devices: red.map((id) => people.get(id).name).join(', ') }) : '');
      layoutHint.set(I18n.t('Drag a device to where it sits on your desk. The pointer crosses where the monitors touch, at the same place along the edge (the lit lines).'));
    }


    const joinSw = UI.switch((v) => api.setMesh({ autoJoin: v }), { label: I18n.t('Join every device automatically') });
    const joinRow = UI.row(I18n.t('Join every device automatically'), '', [joinSw]);

    body.append(
      UI.card(I18n.t('Mesh mode'), [
        UI.row(I18n.t('Use several devices at once'), I18n.t('On. TwinDesk restarts when you turn it on or off'), [turnOff]),
      ]),
      UI.card(I18n.t('Layout'), [map.el, actions, reachNote, layoutHint, skipRow], { cls: 'keep-on' }),
      UI.card(I18n.t('Joining'), [joinRow]),
    );

    return (s) => {
      last = s;
      drawLayout(s);
      const jn = !!(s.mesh && s.mesh.autoJoin === true);
      joinSw.set(jn);
      joinRow.setHint(jn ? I18n.t('Pair with one device and the rest connect to this Mac by themselves. Devices you pair with can introduce others, without a pairing code')
        : I18n.t('Off: this Mac neither introduces devices to each other nor accepts an introduction. Pair each device yourself'));
    };
  },
});
