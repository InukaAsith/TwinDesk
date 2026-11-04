// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume tab (Mac, PC and Linux; with a computer or a phone, shared/rezume.js): go on here with
// the tab, document or phone app in use on the other device, and the other way round. Its switch at
// the top turns it on (off until then: nothing is looked at, no permission asked). What goes
// (pages, documents, phone apps, opened here in a window with Mirror apps), which ways, and where
// the other side's shows: a notification, the taskbar (the Dock on the Mac), the tray (menu bar),
// this tab and the Apps tab / Phone page (UI.rezumeCard, the card they show too). Between two
// computers, also an app's own window (off by default) and documents edited in place; and the two
// allowlists, the apps whose windows and documents may go, with how often each went.
'use strict';

(function () {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

  const mac = /Mac/.test(navigator.platform);
  const linux = /Linux/.test(navigator.platform);
  const kindWord = (o) => (o.kind === 'web' ? tr('Page') : o.kind === 'doc' ? tr('Document') : o.kind === 'window' ? tr('Window') : tr('App'));
  const day = (ts) => { try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (_) { return ''; } };
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  // The other device's offer: its icon, what it is, Open and Dismiss. update(s, always): shown while
  // there is one (always: on the ReZume tab; elsewhere only with "On the Apps and Phone pages").
  UI.rezumeCard = function () {
    const { el, api } = UI;
    const icon = el('span', { class: 'rezume-icon' });
    const open = UI.button(tr('Open'), () => api.rezumeDo({ a: 'take' }), 'small primary');
    const dismiss = UI.button(tr('Dismiss'), () => api.rezumeDo({ a: 'dismiss' }), 'small');
    const row = UI.row('', '', [open, dismiss], { literal: true });
    row.prepend(icon);
    const wrap = UI.card(tr('Continue from {name}'), [row]);
    wrap.hidden = true;
    let key = '';
    return {
      el: wrap,
      update(s, always) {
        const h = s.rezume;
        const i = h && h.on && h.receive && h.incoming;
        wrap.hidden = !i || (!always && !h.tab);
        if (!i) return;
        const k = JSON.stringify([i.id, i.icon ? i.icon.length : 0]);
        if (k !== key) {
          key = k;
          icon.replaceChildren(UI.appIcon(i.icon));
        }
        row.label.textContent = i.title || i.name || i.appName;
        row.setHint(kindWord(i) + ' · ' + (i.kind === 'web' ? hostOf(i.url) : i.kind === 'doc' ? i.name + (i.size ? ', ' + size(i.size) : '')
          : i.kind === 'window' ? tr('{app}, in a window here', { app: i.appName || i.app })
            : (h.mirrorReady ? tr('{app}, in a window here', { app: i.appName || i.app }) : (i.appName || i.app)))
          + (i.appName && i.kind !== 'app' && i.kind !== 'window' ? ' · ' + i.appName : ''));
      },
    };
  };

  UI.tab({
    id: 'rezume',
    order: 85,
    title: 'ReZume',
    icon: 'rezume',
    color: 'linear-gradient(#64d2ff, #0a84ff)',
    desc: tr('Pick up where you left off on your other device.'),
    badge: (s) => (s.rezume && s.rezume.on ? 'on' : ''),
    master: {
      get: (s) => !!(s.rezume && s.rezume.on),
      set: (v) => UI.api.setReZume({ on: v }),
      disabled: (s) => !s.rezume,
    },
    build(body) {
      const { api } = UI;
      const labels = {
        web: 'Web pages', video: 'Videos', docs: 'Documents', apps: 'Phone apps', mirror: 'Mirror apps',
        send: 'Send from this device', receive: 'Receive from {name}', push: 'Open received items automatically', notify: 'Notification',
        taskbar: mac ? 'Dock' : linux ? 'Taskbar or dock' : 'Taskbar', tray: mac ? 'Menu bar' : 'Tray', tab: 'Apps and Phone pages',
        windows: 'App windows', live: 'Edit documents in place', newWindows: 'Allow newly found apps', newFiles: 'Allow newly found apps',
      };
      const set = (k) => UI.switch((v) => api.setReZume({ [k]: v }), { label: tr(labels[k]) });
      const note = UI.note('warn', '');
      const info = UI.note('info', '');
      info.setAttribute('data-literal', '');
      const offer = UI.rezumeCard();

      const status = UI.row('{name}', '');
      const out = UI.row('', '', [], { literal: true });
      const push = UI.button(tr('Send'), () => api.rezumeDo({ a: 'push' }), 'small');
      const outRow = UI.row('', '', [push], { literal: true });
      const now = UI.card(tr('Now'), [status, out, outRow]);

      const sw = {};
      for (const k of ['web', 'video', 'docs', 'apps', 'mirror', 'windows', 'live', 'send', 'receive', 'push', 'notify', 'taskbar', 'tray', 'tab', 'newWindows', 'newFiles']) sw[k] = set(k);
      const webRow = UI.row(tr('Web pages'), '', [sw.web.el]);
      const videoRow = UI.row(tr('Videos'), tr('Resume at the same moment'), [sw.video.el]);
      const docRow = UI.row(tr('Documents'), '', [sw.docs.el]);
      const appRow = UI.row(tr('Phone apps'), '', [sw.apps.el]);
      const mirrorRow = UI.row(tr('Open phone apps in a window'), '', [sw.mirror.el]);
      const liveRow = UI.row(tr('Edit documents in place'), tr('Open the original file on the other computer, so changes are saved where it is stored. When this is off, a copy is opened and removed when TwinDesk quits.'), [sw.live.el]);
      const winRow = UI.row(tr('App windows'), tr('Show an app’s own window from the other computer, for apps without a document or web page'), [sw.windows.el]);
      const what = UI.card(tr('Continue'), [webRow, videoRow, docRow, liveRow, winRow, appRow, mirrorRow]);

      // An allowlist: the apps found so far, each with its switch, how often it was sent, and Remove.
      const allowList = (list, newKey, title, empty) => {
        const items = UI.el('div', { class: 'rezume-list' });
        const none = UI.row(tr(empty), '', [], {});
        const clear = UI.button(tr('Clear list'), () => api.rezumeDo({ a: 'forget', list }), 'small');
        const newRow = UI.row(tr('Allow newly found apps'), tr('When this is off, a new app is added to the list but stays blocked until you allow it'), [sw[newKey].el, clear]);
        const card = UI.card(tr(title), [newRow, none, items]);
        let key = '';
        return {
          el: card,
          update(rows, on) {
            sw[newKey].disable(!on);
            clear.disabled = !rows.length;
            none.hidden = rows.length > 0;
            const k = JSON.stringify(rows.map((r) => [r.app, r.name, r.on, r.sent, r.last, r.icon ? r.icon.length : 0, on]));
            if (k === key) return;
            key = k;
            items.replaceChildren(...rows.map((r) => {
              const s = UI.switch((v) => api.rezumeDo({ a: 'allow', list, app: r.app, on: v }), { label: r.name });
              s.set(r.on);
              s.disable(!on);
              const remove = UI.button(tr('Remove'), () => api.rezumeDo({ a: 'forget', list, app: r.app }), 'small');
              const hint = r.sent ? tr(r.sent === 1 ? 'Sent once · last on {date}' : 'Sent {count} times · last on {date}', { count: r.sent, date: day(r.last) })
                : tr('Found on {date} · not sent yet', { date: day(r.found) });
              const row = UI.row(r.name, hint, [s.el, remove], { literal: true });
              row.prepend(UI.el('span', { class: 'rezume-icon' }, [UI.appIcon(r.icon)]));
              return row;
            }));
          },
        };
      };
      const winList = allowList('windows', 'newWindows', 'Windows from these apps', 'No apps yet. An app is added here the first time its window can be sent.');
      const fileList = allowList('files', 'newFiles', 'Documents from these apps', 'No apps yet. An app is added here the first time one of its documents is offered.');

      const sendRow = UI.row(tr('Send from this device'), '', [sw.send.el]);
      const recvRow = UI.row(tr('Receive from {name}'), '', [sw.receive.el]);
      const pushRow = UI.row(tr('Open received items automatically'), '', [sw.push.el]);
      const ways = UI.card(tr('Sharing'), [sendRow, recvRow, pushRow]);

      const notifyRow = UI.row(tr('Notification'), '', [sw.notify.el]);
      const barRow = UI.row(mac ? tr('Dock') : linux ? tr('Taskbar or dock') : tr('Taskbar'), '', [sw.taskbar.el]);
      const trayRow = UI.row(mac ? tr('Menu bar') : tr('Tray'), '', [sw.tray.el]);
      const tabRow = UI.row(tr('Apps and Phone pages'), '', [sw.tab.el]);
      const where = UI.card(tr('Show in'), [notifyRow, barRow, trayRow, tabRow]);

      body.append(note, offer.el, now, info, what, ways, winList.el, fileList.el, where);

      return (s) => {
        const h = s.rezume || {};
        out.label.textContent = UI.fill(tr('Offered to {name}'));
        outRow.label.textContent = UI.fill(tr('Send to {name}'));
        push.textContent = tr('Send');
        for (const k of Object.keys(sw)) {
          sw[k].set(h[k]);
          sw[k].disable(!h.on);
        }
        sw.mirror.disable(!h.on || !h.apps);
        sw.live.disable(!h.on || !h.docs || !h.liveHere);
        sw.windows.disable(!h.on || !h.windowsHere);
        // ReZume not loaded yet (off): the settings' own records, not the lists — nothing to show.
        winList.update(Array.isArray(h.windowApps) ? h.windowApps : [], !!h.on);
        fileList.update(Array.isArray(h.fileApps) ? h.fileApps : [], !!(h.on && h.docs));
        offer.update(s, true);
        const phone = !!h.phone;
        appRow.hidden = mirrorRow.hidden = !phone;
        liveRow.hidden = winRow.hidden = phone;
        winList.el.hidden = phone || !h.windows;
        winRow.setHint(!h.windowsHere ? tr('This computer can’t send its windows (an Xorg session is needed)')
          : h.windows && h.connected && !phone && h.peerKnows && !h.peerWindows ? tr('Turn on App windows on {name} too')
            : tr('Show an app’s own window from the other computer, for apps without a document or web page'));
        docRow.setHint(phone ? tr('From this computer to the phone') : '');
        mirrorRow.setHint(!h.mirrorReady ? tr('Needs wireless debugging') : '');
        status.setHint(!h.connected ? tr('Not connected')
          : !h.on ? tr('Off here')
            : !h.peerKnows ? tr('Update TwinDesk on {name}')
              : !h.peerOn ? tr('Off on {name}')
                : phone && !h.peerDetects ? (h.mirrorReady ? tr('Ready') : tr('Ready · turn on Accessibility on the phone for its apps'))
                  : tr('Ready'));
        out.hidden = !h.out;
        if (h.out) {
          out.setHint(h.out.title + (h.out.kind === 'web' ? ' · ' + hostOf(h.out.url) : h.out.kind === 'doc' ? ' · ' + h.out.name : h.out.kind === 'window' ? ' · ' + tr('Window') : ''));
        }
        outRow.hidden = !h.on || !h.connected;
        push.disabled = !h.last;
        outRow.setHint(h.last ? h.last.title : tr('Nothing to send yet'));
        note.set(h.on ? tr(h.why || '') : '');
        const template = h.message === '{name} has no ReZume yet: update TwinDesk there' || h.message === 'ReZume is off on {name}' || h.message === '{name} does not accept this item';
        const message = h.on ? (h.waiting ? tr('Getting {item}…', { item: h.waiting }) : template ? tr(h.message, { name: UI.peer(s).name }) : tr(h.message || '')) : '';
        info.textContent = message;
        info.hidden = !message;
      };
    },
  });
})();
