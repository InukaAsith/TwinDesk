// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps tab (copy of windows/ui-apps.js). The other computer → here: its apps with their icons;
// click one and it opens there, its windows appearing here as their own windows (a Mac: apps.js,
// cropped from its screen stream, with Add to app menu; a PC or Linux: peerapps.js). Here → there:
// it opens this computer's apps (pcapps.js, Xorg only); each window is streamed on its own.
'use strict';

UI.tab({
  id: 'apps',
  for: ['computer'], // another computer's (shared/ui-kinds.js)
  order: 80,
  title: 'Apps',
  color: 'linear-gradient(#bf5af2, #5e5ce6)',
  desc: 'Use apps from the other computer in their own windows.',
  master: { get: (s) => s.macApps.on || s.pcApps.allow, set: (v) => { UI.api.setMacApps({ on: v }); UI.api.setPcApps({ allow: v }); } },
  badge: (s) => (s.apps.open + s.pcApps.streaming ? String(s.apps.open + s.pcApps.streaming) : ''),
  build(body) {
    const { el, api } = UI;
    const t = (...args) => I18n.t(...args);
    const note = UI.note('warn', '', { literal: true });
    const appMessage = (message, apps = []) => {
      const suffix = ' is in Start › TwinDesk Apps. Right-click it there to pin it to Start or the taskbar.';
      if (message.endsWith(suffix)) return t('{app} is in Start › TwinDesk Apps. Right-click it there to pin it to Start or the taskbar.', { app: message.slice(0, -suffix.length) });
      const app = apps.slice().sort((a, b) => b.name.length - a.name.length).find((a) => message.startsWith('Couldn’t add ' + a.name + ' to Start: '));
      if (app) return t('Couldn’t add {app} to Start: {error}', { app: app.name, error: message.slice(('Couldn’t add ' + app.name + ' to Start: ').length) });
      if (message.startsWith('Couldn’t open ')) return t('Couldn’t open {detail}', { detail: message.slice('Couldn’t open '.length) });
      if (message.startsWith('Couldn’t list this PC’s apps: ')) return t('Couldn’t list this PC’s apps: {error}', { error: message.slice('Couldn’t list this PC’s apps: '.length) });
      return message;
    };
    const refresh = UI.button(t('Refresh'), () => api.listApps(), 'small');
    const filter = el('input', { type: 'text', placeholder: t('Search apps'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Search apps') } });
    const grid = el('div', { class: 'app-grid', attrs: { 'data-literal': '' } });
    const status = UI.row('', '');
    const openCount = UI.row('', '', [], { literal: true });
    const pcState = UI.row('', '', [], { literal: true });
    const pair = UI.dirCards(
      { on: { get: (s) => s.macApps.on, set: (v) => api.setMacApps({ on: v }) }, label: t('Open {name}’s apps on {me}'), hint: t('Pick one below'), rows: [openCount] },
      { on: { get: (s) => s.pcApps.allow, set: (v) => api.setPcApps({ allow: v }) }, label: t('Open {me}’s apps on {name}'), hint: t('Pick them over there'), rows: [pcState] },
    );
    // Move windows (shared/movewin.js): the key held, a window clicked and dragged past the shared
    // edge moves to the other computer (and back the same way). Off: nothing of it is loaded.
    const MOVE_KEYS = [['ControlRight', t('Right Ctrl')], ['ControlLeft', t('Left Ctrl')], ['AltRight', t('Right Alt')], ['AltLeft', t('Left Alt')],
      ['ShiftRight', t('Right Shift')], ['ShiftLeft', t('Left Shift')], ['MetaRight', t('Right Super')], ['MetaLeft', t('Left Super')]];
    const moveSw = UI.switch((v) => api.setPcApps({ moveWindows: v }), { label: t('Move windows') });
    const moveKey = UI.select(MOVE_KEYS.map(([value, label]) => ({ value, label })), (v) => api.setPcApps({ moveKey: v }));
    const moveKeyRow = UI.row(t('Key to hold'), t('Hold it, then click anywhere in a window and drag'), [moveKey]);
    const moveCard = UI.card(t('Move windows'), [
      UI.row(t('Move windows to {name}'), t('Drag a window past the edge with the key held: it opens on {name} and leaves this screen. Drag it back or close it there to bring it home'), [moveSw]),
      moveKeyRow,
    ]);
    const listCard = UI.card(t('Mac apps'), [UI.row(t('Search'), '', [filter]), grid, status], { actions: [refresh] });
    const rezume = UI.rezumeCard ? UI.rezumeCard() : { el: UI.el('div', { hidden: true }), update() {} }; // the other computer's ReZume (shared/ui-rezume.js; not in Multi-device)
    body.append(pair.el, rezume.el, note, listCard, moveCard); // Move windows below the apps list
    filter.oninput = () => { key = ''; if (UI.state) render(UI.state); };

    let key = '';
    let asked = false;
    function render(s) {
      rezume.update(s);
      moveSw.set(!!s.pcApps.moveWindows);
      moveKey.set(s.pcApps.moveKey || 'ControlRight');
      moveKeyRow.hidden = !s.pcApps.moveWindows;
      const a = s.apps;
      const connected = s.link.state === 'connected';
      pair.update(s); // the two direction switches follow the settings
      listCard.hidden = !s.macApps.on;
      const device = UI.peer(s).name;
      const listTitle = listCard.querySelector('.card-title > span');
      listTitle.dataset.literal = '';
      listTitle.textContent = t('{device}’s apps', { device });
      if (connected && s.macApps.on && !asked && !a.list.length) { asked = true; api.listApps(); }
      openCount.hidden = !a.open;
      openCount.label.textContent = t('{count} open here', { count: a.open });
      const pa = s.pcApps;
      pcState.hidden = !pa.allow;
      pcState.label.textContent = pa.streaming ? t('{count} open on {name}', { count: pa.streaming, name: device })
        : !connected ? t('Waiting for {name}', { name: device }) : !pa.macAccepts ? t('Turned off on {name}', { name: device }) : pa.open ? t('Connecting…') : t('None open');
      pcState.setHint(pa.message ? appMessage(pa.message) : pa.wayland ? t('Needs an Xorg session: Wayland doesn’t let apps show other apps’ windows') : '');
      if (!connected) asked = false;
      note.set(appMessage(a.message || '', a.list));
      note.className = 'note ' + (/ is in the app menu/.test(a.message) ? 'info' : 'warn');
      refresh.disabled = !connected || a.loading;
      const q = filter.value.trim().toLowerCase();
      const k = JSON.stringify([a.list.length, a.loading, connected, q, !!a.peerPc, device]);
      if (k === key) return;
      key = k;
      const items = a.list.filter((x) => !q || x.name.toLowerCase().includes(q));
      grid.replaceChildren(...items.map((x) => {
        const b = el('button', { class: 'app-tile', title: t('Open {app} on {device}', { app: x.name, device }) }, [
          UI.appIcon(x.icon),
          el('span', { class: 'app-name', text: x.name }),
        ]);
        b.onclick = () => api.launchApp(x.id);
        if (a.peerPc) return b; // apps of a PC or Linux computer: no launcher yet
        // Add to the app menu (a launcher you can pin to the dock), on hover or right-click.
        const pin = el('span', { class: 'app-pin', title: t('Add to the app menu'), attrs: { role: 'button', tabindex: '0', 'aria-label': t('Add {app} to the app menu', { app: x.name }) } }, [UI.icon('pin')]);
        pin.onclick = (e) => { e.stopPropagation(); api.pinApp(x.id); };
        pin.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); api.pinApp(x.id); } };
        b.oncontextmenu = (e) => { e.preventDefault(); api.pinApp(x.id); };
        b.append(pin);
        return b;
      }));
      status.hidden = items.length > 0;
      status.label.textContent = !connected ? t('Waiting for {name}') : a.loading ? t('Loading…') : q ? t('No app matches') : t('No apps yet');
      status.setHint(!connected || a.loading || q ? '' : t('Click Refresh to ask {name} for its apps.'));
    }
    return render;
  },
});
