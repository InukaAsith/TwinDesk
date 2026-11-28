// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drop (shared/drop.js, shared/drop-host.js): one conversation with every TwinDesk device, on Mac, Windows
// and Linux, one-to-one and Multi-device. The composer sends to everyone or to one device; files and
// pictures (up to 5 MB) go with the message. state.drop = {on, unread, rev}; the room itself comes from
// api.drop({do: 'view'}) when rev changes, so state pushes stay small.
'use strict';

(function () {
  const tr = (k, v) => I18n.t(k, v);
  const api = () => UI.api;
  const call = (a) => Promise.resolve(api().drop ? api().drop(a) : null).catch(() => null);
  const bytes = (n) => (UI.bytes ? UI.bytes(n) : `${Math.round(n / 1024)} KB`);
  const clock = (at) => (UI.clock ? UI.clock(at) : new Date(at).toLocaleString());

  const GEAR = 'M16.02 8.14 L18.04 8.37 L18.04 11.63 L16.02 11.86 L15.57 12.94 L16.83 14.53 L14.53 16.83 L12.94 15.57 L11.86 16.02 L11.63 18.04 L8.37 18.04 L8.14 16.02 L7.06 15.57 L5.47 16.83 L3.17 14.53 L4.43 12.94 L3.98 11.86 L1.96 11.63 L1.96 8.37 L3.98 8.14 L4.43 7.06 L3.17 5.47 L5.47 3.17 L7.06 4.43 L8.14 3.98 L8.37 1.96 L11.63 1.96 L11.86 3.98 L12.94 4.43 L14.53 3.17 L16.83 5.47 L15.57 7.06Z M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z';
  // The message actions' icons (20 × 20, stroked).
  const ICON = {
    gear: GEAR,
    open: 'M11 3.5h5.5V9 M16.5 3.5 9 11 M14 12v4.5H3.5V6H8',
    save: 'M10 3v10 M5.5 8.5 10 13l4.5-4.5 M3.5 16.5h13',
    folder: 'M2.5 5.5h5l1.5 2h8.5v8.5h-15z',
    copy: 'M7 7h9.5v9.5H7z M13 7V3.5H3.5V13H7',
    del: 'M4 5.5h12 M8 5.5V3.5h4v2 M5.5 5.5l.8 11h7.4l.8-11 M8.5 8.5v5 M11.5 8.5v5',
    delAll: 'M4 5.5h12 M8 5.5V3.5h4v2 M5.5 5.5l.8 11h7.4l.8-11 M8 9l4 4 M12 9l-4 4',
  };
  const svgIcon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICON[name]);
    svg.append(p);
    return svg;
  };
  const gearIcon = () => svgIcon('gear');

  UI.tab({
    id: 'drop',
    group: 'Share',
    order: 51,
    title: tr('Drop'),
    icon: 'message',
    color: 'linear-gradient(#ffcc00, #ff9500)',
    desc: tr('One conversation with all your devices: messages, links, pictures and files.'),
    master: { get: (s) => !!(s.drop && s.drop.on), set: (v) => call({ do: 'set', on: v }) },
    badge: (s) => (s.drop && s.drop.on ? (s.drop.unread ? String(s.drop.unread) : 'on') : ''),
    build(body) {
      const { el } = UI;
      body.setAttribute('data-literal', '');
      let view = null;
      let to = '*';

      const toSel = UI.select([{ value: '*', label: tr('Everyone') }], (v) => { to = v; });
      toSel.el.classList.add('drop-to');
      toSel.el.setAttribute('aria-label', tr('Send to'));
      // The gear: Devices (who's in the room, Block) and Clear All, in place of the conversation.
      const gear = el('button', { class: 'drop-gear', title: tr('Devices'), attrs: { 'aria-label': tr('Devices') } }, [gearIcon()]);
      const head = el('div', { class: 'hub-conv-head web-conv-head' }, [
        el('div', { class: 'drop-to-wrap' }, [el('span', { class: 'hint', text: tr('To') }), toSel.el]),
        gear,
      ]);
      const bubbles = el('div', { class: 'hub-bubbles' });
      const empty = el('div', { class: 'hub-conv-empty hint', text: tr('No messages yet. What you send here reaches every device, or the one you pick.') });
      const scroll = el('div', { class: 'hub-conv-scroll' }, [empty, bubbles]);
      const note = el('div', { class: 'drop-note hint', hidden: true });
      const box = el('textarea', { class: 'hub-compose', rows: 1, placeholder: tr('Message'), attrs: { 'aria-label': tr('Message') } });
      const say = (text) => { note.textContent = text || ''; note.hidden = !text; };
      const sent = (r) => {
        if (!r) return;
        if (r.why === 'off') say(tr('Drop is off.'));
        else if (r.big && r.big.length) say(tr('Too large for Drop (5 MB at most): {names}. Send it from File Sharing instead.', { names: r.big.join(', ') }));
        else if (r.bad && r.bad.length) say(tr('Couldn’t read {names}.', { names: r.bad.join(', ') }));
        else say('');
      };
      const send = async () => {
        const text = box.value.trim();
        if (!text) return;
        box.value = '';
        box.style.height = '';
        sent(await call({ do: 'send', to, text }));
      };
      box.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
      box.oninput = () => { box.style.height = ''; box.style.height = `${Math.min(140, box.scrollHeight)}px`; };
      const attach = UI.button('+', async () => sent(await call({ do: 'files', to })), 'hub-attach-btn');
      attach.title = tr('Attach files');
      const conv = el('div', { class: 'hub-conv' }, [head, scroll, note, el('div', { class: 'hub-compose-row' }, [attach, el('div', { class: 'hub-compose-col' }, [box]), UI.button(tr('Send'), send, 'primary')])]);
      const devList = el('div', { class: 'drop-dev-list' });
      const setHead = el('div', { class: 'hub-conv-head web-conv-head' }, [el('div', { class: 'hub-conv-name', text: tr('Devices') }), UI.button(tr('Done'), () => showSettings(false), 'small')]);
      const clearRow = UI.row(tr('Clear All'), tr('Removes every message from this computer only. The other devices keep theirs.'), [UI.button(tr('Clear All'), () => { call({ do: 'clear' }); showSettings(false); }, 'small')]);
      const settings = el('div', { class: 'hub-conv drop-settings', hidden: true }, [setHead, el('div', { class: 'hub-conv-scroll' }, [devList, clearRow])]);
      const showSettings = (on) => { settings.hidden = !on; conv.hidden = on; gear.classList.toggle('on', on); };
      gear.onclick = () => showSettings(true);
      const card = el('div', { class: 'card web-drop drop-room' }, [conv, settings]);
      body.append(card);
      // The card fills the window below the page's title, whatever the title's height.
      const fit = () => {
        const top = card.getBoundingClientRect().top;
        if (!card.offsetParent || top <= 0) return;
        let h = Math.max(360, Math.floor(window.innerHeight - top - 20));
        card.style.setProperty('--drop-h', `${h}px`);
        // Whatever the page adds below it (padding, margins): taken off, so the page itself never scrolls.
        const sc = document.getElementById('content') || document.scrollingElement;
        const over = sc ? sc.scrollHeight - sc.clientHeight : 0;
        if (over > 0) { h = Math.max(360, h - over); card.style.setProperty('--drop-h', `${h}px`); }
      };
      window.addEventListener('resize', fit);
      new ResizeObserver(fit).observe(body);
      conv.addEventListener('dragover', (e) => { e.preventDefault(); conv.classList.add('hub-drop'); });
      conv.addEventListener('dragleave', (e) => { if (!conv.contains(e.relatedTarget)) conv.classList.remove('hub-drop'); });
      conv.addEventListener('drop', async (e) => {
        e.preventDefault();
        conv.classList.remove('hub-drop');
        const paths = api().pathsOf ? api().pathsOf(e.dataTransfer.files) : [];
        if (paths.length) sent(await call({ do: 'files', to, paths }));
      });


      const thumbs = new Map(); // id -> data URL (pictures load once)
      const picture = (x) => {
        const img = el('img', { class: 'hub-pic', alt: x.file.name });
        const set = (u) => { if (u) img.src = u; };
        if (thumbs.has(x.id)) set(thumbs.get(x.id));
        else call({ do: 'thumb', id: x.id }).then((u) => { if (u) { thumbs.set(x.id, u); set(u); } });
        return img;
      };

      const small = (icon, label, fn) => {
        const b = el('button', { class: 'drop-act', title: label, attrs: { 'aria-label': label } }, [svgIcon(icon)]);
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
      };
      const time = (at) => new Date(at).toLocaleTimeString(I18n.locale || undefined, { hour: 'numeric', minute: '2-digit' });

      function bubble(x) {
        const kids = [];
        if (!x.mine || x.to !== '*') {
          const who = x.mine ? tr('To {name}', { name: x.toName || tr('one device') }) : x.to === '*' ? x.name : tr('{name}, only to you', { name: x.name });
          kids.push(el('div', { class: 'hub-from', text: who }));
        }
        if (x.file) {
          if (x.file.image) kids.push(picture(x));
          kids.push(el('div', { class: 'web-file' }, [UI.icon('doc'), el('div', { class: 'web-file-text' }, [el('div', { class: 'web-file-name', text: x.file.name }), el('div', { class: 'hub-status', text: bytes(x.file.size || 0) })])]));
        }
        if (x.text) kids.push(el('div', { class: 'hub-text', text: x.text }));
        const acts = el('div', { class: 'drop-acts' }, [el('span', { class: 'drop-time', text: time(x.at), title: new Date(x.at).toLocaleString() })]);
        if (x.file) {
          acts.append(small('open', tr('Open'), () => call({ do: 'open', id: x.id })), small('save', tr('Save to Downloads'), () => call({ do: 'save', id: x.id })), small('folder', tr('Show in folder'), () => call({ do: 'reveal', id: x.id })));
        }
        if (x.text) acts.append(small('copy', tr('Copy'), () => { if (api().copyText) api().copyText(x.text); else navigator.clipboard.writeText(x.text).catch(() => {}); }));
        acts.append(small('del', tr('Delete for me'), () => call({ do: 'del', id: x.id })));
        if (x.mine) acts.append(small('delAll', tr('Delete for everyone'), () => call({ do: 'del', id: x.id, all: true })));
        kids.push(acts);
        const b = el('div', { class: `hub-bubble ${x.mine ? 'out' : 'in'}` }, kids);
        if (x.file) b.ondblclick = () => call({ do: 'open', id: x.id });
        return b;
      }

      function paint() {
        const v = view;
        if (!v) return;
        const online = v.members.filter((d) => d.online);
        toSel.options([{ value: '*', label: tr('Everyone') }, ...online.map((d) => ({ value: d.id, label: d.name }))]);
        if (to !== '*' && !online.some((d) => d.id === to)) to = '*';
        toSel.set(to);
        empty.hidden = v.items.length > 0;
        const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
        const nodes = [];
        let day = '';
        for (const x of v.items) {
          const d = new Date(x.at).toDateString();
          if (d !== day) { day = d; nodes.push(el('div', { class: 'hub-day', text: clock(x.at) })); }
          nodes.push(bubble(x));
        }
        bubbles.replaceChildren(...nodes);
        if (atEnd || paint.first) scroll.scrollTop = scroll.scrollHeight;
        paint.first = false;
        // Devices
        const rows = [];
        const blocked = new Map(v.blocked.map((b) => [b.id, b.name]));
        for (const d of v.members) {
          const isBlocked = blocked.has(d.id);
          blocked.delete(d.id);
          rows.push(UI.row(d.name, isBlocked ? tr('Blocked: its messages aren’t shown here') : d.online ? tr('Connected') : tr('Not connected'),
            [UI.button(isBlocked ? tr('Unblock') : tr('Block'), () => call({ do: 'set', block: { id: d.id, on: !isBlocked, name: d.name } }), 'small')], { literal: true }));
        }
        for (const [id, name] of blocked) rows.push(UI.row(name, tr('Blocked: its messages aren’t shown here'), [UI.button(tr('Unblock'), () => call({ do: 'set', block: { id, on: false } }), 'small')], { literal: true }));
        if (!rows.length) rows.push(UI.row(tr('No other devices yet'), tr('Phones and computers connected to this one join the conversation.'), [], { literal: true }));
        devList.replaceChildren(...rows);
      }
      paint.first = true;

      let rev = -1;
      let asking = false;
      return (s) => {
        const d = s.drop;
        requestAnimationFrame(fit);
        if (!d || !d.on) return;
        if (d.unread && document.hasFocus()) call({ do: 'read' });
        if (d.rev === rev || asking) return;
        asking = true;
        const want = d.rev;
        call({ do: 'view' }).then((v) => {
          asking = false;
          if (!v) return;
          rev = want;
          view = v;
          paint();
        });
      };
    },
  });
})();
