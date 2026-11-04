// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mirroring and Apps (Mac, PC and Linux), the phone's two pages that were on the Phone page:
//   Mirroring: the phone's screen in a window, what's open here, and how phone windows look and
//   behave (sound, picture, controls, keys).
//   Apps: the phone's apps, each opened in a window of its own.
// Only while a phone is connected; both need wireless debugging (Connection).
'use strict';

(function () {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

  const mac = /Mac/.test(navigator.platform);
  const linux = /Linux/.test(navigator.platform);
  const here = mac ? tr('this Mac') : linux ? tr('this computer') : tr('this PC');
  const isPhone = (s) => !!(s && s.phone && s.phone.connected);

  // Wireless debugging isn't ready: one line, with the way to Connection.
  const needAdb = () => {
    const row = UI.row(tr('Wireless debugging isn’t set up'), tr('Mirroring and phone apps need it. Set it up once on the Connection page.'), [UI.button(tr('Set Up'), () => UI.go('connection'), 'small primary')]);
    const card = UI.card('', [row]);
    return { el: card, update(s) { const br = (s.phone || {}).bridge || {}; card.hidden = br.state === 'ready'; row.setHint(br.state === 'connecting' ? tr('Connecting to the phone’s wireless debugging…') : tr('Mirroring and phone apps need it. Set it up once on the Connection page.')); } };
  };

  UI.tab({
    id: 'mirror',
    order: 9,
    title: tr('Mirroring'),
    icon: 'phone',
    color: 'linear-gradient(#64d2ff, #0a84ff)',
    desc: tr('The phone’s screen in a window, with touch, mouse and keyboard.'),
    hidden: (s) => !isPhone(s),
    build(body) {
      const { el, api } = UI;
      const adb = needAdb();
      const showBtn = UI.button(tr('Show Phone Screen'), () => api.phoneScreen(true), 'primary');
      const showRow = UI.row(tr('Phone screen'), tr('Opens in its own window. Close it any time; the phone keeps running.'), [showBtn]);
      const winList = el('div');
      const winCard = UI.card(tr('Open on {computer}', { computer: here }), [winList]);

      const sound = UI.switch((v) => api.setPhone({ sound: v }), { label: tr('Phone sound') });
      const quality = UI.select([
        { value: '4', label: tr('Data saver · 4 Mb/s') }, { value: '8', label: tr('Balanced · 8 Mb/s') },
        { value: '16', label: tr('Sharp · 16 Mb/s') }, { value: '24', label: tr('Sharpest · 24 Mb/s') },
      ], (v) => api.setPhone({ bitrateMbps: Number(v) }));
      const rows = [
        UI.row(tr('Play phone sound here'), tr('Android 11 or later'), [sound]),
        UI.row(tr('Picture quality'), tr('For the phone screen and app windows'), [quality]),
      ];
      // Windows: where the buttons sit (settings.phone.controls); the panel itself opens and closes
      // from each window's title bar and stays as it was left (settings.phone.panel).
      let controls = null;
      if (!mac && !linux) {
        controls = UI.select([
          { value: 'top', label: tr('Title bar') }, { value: 'side', label: tr('Side panel') }, { value: 'bottom', label: tr('Bottom bar') },
        ], (v) => api.setPhone({ controls: v }));
        rows.push(UI.row(tr('Phone controls'), tr('Where Back, Home, Recents and the other buttons sit. The panel button in each window’s title bar shows or hides them.'), [controls]));
      }
      let enterSends = null, arrowSwipe = null;
      if (!linux) {
        enterSends = UI.switch((v) => api.setPhone({ enterSends: v }), { label: tr('{key} sends messages', { key: mac ? 'Return' : 'Enter' }) });
        rows.push(UI.row(tr('{key} sends messages', { key: mac ? 'Return' : 'Enter' }), tr('In WhatsApp, Instagram and Telegram. {shortcut} adds a new line.', { shortcut: mac ? '⇧Return' : 'Shift+Enter' }), [enterSends]));
        arrowSwipe = UI.switch((v) => api.setPhone({ arrowSwipe: v }), { label: tr('Arrow keys swipe') });
        rows.push(UI.row(tr('Arrow keys swipe'), tr('Up and down through feeds and Shorts, left and right through pages. Off: arrows move the text cursor.'), [arrowSwipe]));
      }
      const optsCard = UI.card(tr('Phone windows'), rows);
      const kbRow = UI.row(tr('Mouse and keyboard'), tr('Push the pointer past the screen edge to use the phone.'), [UI.button(tr('Mouse Settings'), () => UI.go('cursor'), 'small')]);

      body.append(adb.el, UI.card('', [showRow]), winCard, UI.card('', [kbRow]), optsCard); // the settings last

      let winKey = '';
      return (s) => {
        adb.update(s);
        const ph = s.phone || {};
        const br = ph.bridge || {};
        showBtn.disabled = br.state !== 'ready';
        const st = ph.settings || {};
        sound.set(!!st.sound);
        quality.set(String(st.bitrateMbps || 8));
        if (controls) controls.set(st.controls || 'top');
        if (enterSends) enterSends.set(st.enterSends !== false);
        if (arrowSwipe) arrowSwipe.set(st.arrowSwipe === true);
        const wins = br.windows || [];
        winCard.hidden = !wins.length;
        const wk = JSON.stringify(wins);
        if (wk !== winKey) {
          winKey = wk;
          winList.replaceChildren(...wins.map((w) => UI.row(w.kind === 'screen' ? tr('Phone screen') : w.title, w.kind === 'screen' ? tr('Mirror') : w.app, [UI.button(tr('Close'), () => api.phoneCloseView(w.id), 'small')], { literal: true })));
        }
      };
    },
  });

  UI.tab({
    id: 'papps',
    order: 7.5,
    title: tr('Apps'),
    heading: tr('Phone apps'),
    icon: 'apps',
    color: 'linear-gradient(#5ac8fa, #007aff)',
    desc: tr('Open any phone app in its own window.'),
    hidden: (s) => !isPhone(s),
    build(body) {
      const { el, api } = UI;
      const adb = needAdb();
      const search = el('input', { type: 'search', placeholder: tr('Search apps'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': tr('Search apps') } });
      const count = el('span', { class: 'hint' });
      const grid = el('div', { class: 'app-grid' });
      const note = UI.note('info', '');
      search.oninput = () => { key = ''; UI.state && render(UI.state); };
      const menuWord = mac ? 'add it to the Dock' : linux ? '' : 'pin it to Start';
      body.append(adb.el, el('div', { class: 'papps-bar' }, [search, count]), note, el('div', { class: 'card' }, [grid]));

      let key = '';
      function render(s) {
        adb.update(s);
        const ph = s.phone || {};
        const ready = (ph.bridge || {}).state === 'ready';
        const apps = (UI.phoneAssets && UI.phoneAssets.apps) || [];
        const term = search.value.trim().toLowerCase();
        const shown = term ? apps.filter((a) => a.name.toLowerCase().includes(term)) : apps;
        count.textContent = apps.length ? tr(term ? '{shown} of {total}' : '{total} apps', { shown: shown.length, total: apps.length }) : '';
        note.set(ready && !apps.length ? tr('Loading the phone’s apps…') : '');
        const k = JSON.stringify([shown.length, term, ph.assets, ready]);
        if (k === key) return;
        key = k;
        grid.replaceChildren(...shown.slice(0, 400).map((a) => {
          const b = el('button', { class: 'app-tile', attrs: { 'data-literal': '' }, title: tr(mac ? 'Open {app} · Right-click to add it to the Dock' : menuWord ? 'Open {app} · Right-click to pin it to Start' : 'Open {app}', { app: a.name }), disabled: !ready }, [UI.appIcon(a.icon), el('span', { text: a.name })]);
          b.onclick = () => api.phoneOpenApp({ id: a.id, name: a.name });
          if (api.phoneAppMenu && menuWord) b.oncontextmenu = (e) => { e.preventDefault(); api.phoneAppMenu({ id: a.id, name: a.name }); };
          return b;
        }));
      }
      return render;
    },
  });
})();
