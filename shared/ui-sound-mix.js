// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio › the mixer: which computers play this computer's sound, on which of their speakers and how
// loud on each (From), and the same for each computer's sound here (To). Several at once, a volume per
// speaker. Multi-device lists every connected computer (state.audio.edges, shared/sound-mesh.js and
// mac/mesh/audioset.js); one-to-one the other computer. The routes live with the receiver
// (shared/sound-route.js); a computer's speakers show once its sound plays there.
//
// UI.soundMixer() → {el, update(state)}. Rows are kept while the devices and speakers stay the same,
// so a slider being dragged isn't rebuilt under the pointer.
'use strict';

(function () {
  const t = (k, v) => I18n.t(k, v);
  const OSNAME = { mac: 'macOS', win: 'Windows', windows: 'Windows', linux: 'Linux' };
  const live = (x) => x === true || !!(x && x.status === 'live');
  const pct = (v) => Math.round((Number(v) || 0) * 100) + '%';

  function checkbox(onChange, label) {
    const el = UI.el('input', { class: 'smx-check', attrs: { type: 'checkbox', 'aria-label': label || '' } });
    el.onchange = () => onChange(el.checked);
    return el;
  }

  // A range with its percentage; onInput(v) at once, onCommit(v) shortly after the last move.
  function volume(onInput, onCommit, label) {
    const input = UI.el('input', { class: 'smx-range', attrs: { type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': label || '' } });
    const out = UI.el('span', { class: 'smx-pct' });
    let timer = null;
    let dragging = false;
    const paint = () => {
      out.textContent = pct(input.value);
      input.style.setProperty('--fill', (Number(input.value) * 100) + '%');
    };
    input.oninput = () => {
      dragging = true;
      paint();
      if (onInput) onInput(Number(input.value));
      clearTimeout(timer);
      timer = setTimeout(() => { dragging = false; onCommit(Number(input.value)); }, 150);
    };
    return {
      els: [input, out],
      set(v) {
        if (dragging || v == null) return;
        input.value = String(v);
        paint();
      },
    };
  }

  // The devices the mixer shows, the same shape in Multi-device and one-to-one.
  function devicesOf(s) {
    const a = s.audio || {};
    if (Array.isArray(a.edges)) return a.edges.filter((e) => !/^(android|ios)$/.test(e.os || ''));
    const p = UI.peer(s);
    const connected = s.client !== undefined ? !!s.client : !!(s.link && s.link.state === 'connected');
    if (!connected || p.phone) return [];
    return [{
      id: 'peer', name: p.name, os: p.os, sendOn: !!a.send, recvOn: !!a.receive, sending: live(a.sending), receiving: live(a.receiving),
      accepts: a.macAccepts !== undefined ? !!a.macAccepts : !!a.peerAccepts, remote: a.remote || null, local: a.local || null,
    }];
  }

  UI.soundMixer = function () {
    const api = UI.api;
    let tab = 'out';
    let s = null;
    let shape = '';
    const rows = new Map(); // key → {update(d)}
    const title = UI.el('span');
    const seg = UI.segmented([
      { value: 'out', label: UI.fill(t('From {me}')) },
      { value: 'in', label: UI.fill(t('To {me}')) },
    ], (v) => { tab = v; seg.set(v); if (v === 'out') readVolume(); render(); });
    seg.set(tab);
    const list = UI.el('div', { class: 'smx' });
    const empty = UI.el('div', { class: 'smx-empty' });
    const syncSw = UI.switch((v) => api.setAudio({ sync: v }), { label: t('Keep speakers in sync') });
    const syncRow = UI.row(t('Keep speakers in sync'), t('Every computer plays 0.2 s late, so speakers in one room play together.'), [syncSw]);
    const head = UI.el('div', { class: 'card-title smx-head' }, [title, UI.el('span', { class: 'actions' }, [seg.el])]);
    const card = UI.el('div', { class: 'card smx-card' }, [list, empty, syncRow]);
    const el = UI.el('div', { class: 'card-wrap' }, [head, card]);

    // This computer's own speakers (From): play here too (not muted while sending), and their volume.
    let sysVol = null;
    const selfCheck = checkbox((on) => api.setAudio({ muteLocal: !on }), t('Play on {me} too'));
    const selfVol = volume(null, (v) => api.soundVolume && api.soundVolume(v).then((r) => { sysVol = r && r.volume; }), t('Volume'));
    const selfName = UI.el('span', { class: 'smx-name' });
    const selfRow = UI.el('div', { class: 'smx-dev smx-self' }, [
      UI.el('label', { class: 'smx-line' }, [selfCheck, selfName]), UI.el('span', { class: 'smx-vol' }, selfVol.els),
    ]);
    function readVolume() {
      if (!api.soundVolume) return;
      api.soundVolume().then((r) => { sysVol = r && r.volume; selfVol.set(sysVol); selfRow.classList.toggle('novol', sysVol == null); }).catch(() => {});
    }
    readVolume();

    function setRoute(d, outs) {
      if (api.soundRoute) api.soundRoute({ id: d.id, dir: tab, outs });
    }

    function onOf(d) { return tab === 'out' ? d.sendOn : d.recvOn; }
    function sideOf(d) { return tab === 'out' ? d.remote : d.local; }
    function setOn(d, on) {
      const dir = tab === 'out' ? 'out' : 'in';
      if (d.id !== 'peer' && api.setConsent) api.setConsent(d.id, 'audio', dir, on);
      else api.setAudio(dir === 'out' ? { send: on } : { receive: on });
    }

    function status(d) {
      if (!onOf(d)) return { text: '', cls: '' };
      const side = sideOf(d);
      const ms = side && side.lat ? ', ' + t('{ms} ms', { ms: side.lat }) : '';
      if (tab === 'out') {
        if (d.sending) return { text: t('Playing') + ms, cls: 'good' };
        if (!d.accepts) return { text: t('Turned off on {device}', { device: d.name }), cls: '' };
        return { text: t('Connecting…'), cls: '' };
      }
      if (d.receiving) return { text: t('Playing') + ms, cls: 'good' };
      return { text: t('Waiting for {device}', { device: d.name }), cls: '' };
    }

    function deviceRow(d0) {
      let d = d0;
      const check = checkbox((on) => setOn(d, on), d.name);
      const name = UI.el('span', { class: 'smx-name', text: d.name });
      const sub = UI.el('span', { class: 'smx-sub' });
      const st = UI.el('span', { class: 'smx-status' });
      const outsEl = UI.el('div', { class: 'smx-outs' });
      const row = UI.el('div', { class: 'smx-dev' }, [
        UI.el('div', { class: 'smx-top' }, [UI.el('label', { class: 'smx-line' }, [check, name, sub]), st]), outsEl,
      ]);
      const outRows = new Map();
      let route = [];
      function outRow(o) {
        const c = checkbox((on) => {
          const next = route.filter((r) => r.id !== o.id);
          if (on) next.push({ id: o.id, vol: 1 });
          route = next;
          setRoute(d, next);
        }, o.name);
        const vol = volume(null, (v) => {
          route = route.map((r) => (r.id === o.id ? { ...r, vol: v } : r));
          setRoute(d, route);
        }, o.name);
        const volEl = UI.el('span', { class: 'smx-vol' }, vol.els);
        const r = UI.el('div', { class: 'smx-out' }, [UI.el('label', { class: 'smx-line' }, [c, UI.el('span', { class: 'smx-oname', text: o.name })]), volEl]);
        outsEl.append(r);
        return {
          update(rt) {
            const mine = rt.find((x) => x.id === o.id);
            c.checked = !!mine;
            volEl.hidden = !mine;
            r.classList.toggle('off', !mine);
            if (mine) vol.set(mine.vol);
          },
        };
      }
      return {
        el: row,
        update(next) {
          d = next;
          const on = onOf(d);
          check.checked = on;
          name.textContent = d.name;
          sub.textContent = OSNAME[d.os] || '';
          row.classList.toggle('off', !on);
          const stt = status(d);
          st.textContent = stt.text;
          st.className = 'smx-status ' + stt.cls;
          const side = sideOf(d);
          const outs = on && side ? side.outs || [] : [];
          route = (side && Array.isArray(side.route)) ? side.route.slice() : [];
          outsEl.hidden = !outs.length;
          for (const o of outs) {
            if (!outRows.has(o.id)) outRows.set(o.id, outRow(o));
            outRows.get(o.id).update(route);
          }
        },
      };
    }

    function render() {
      if (!s) return;
      const a = s.audio || {};
      const devs = devicesOf(s);
      const me = UI.fill('{me}');
      const [fromBtn, toBtn] = seg.el.children;
      fromBtn.textContent = t('From {me}', { me });
      toBtn.textContent = t('To {me}', { me });
      title.textContent = tab === 'out' ? t('Play {me}’s sound on', { me }) : t('Play on {me}', { me });
      // Rebuilt only when what's listed changes (devices, their switch, their speakers).
      const key = tab + '|' + devs.map((d) => {
        const side = sideOf(d);
        return d.id + ':' + onOf(d) + ':' + ((onOf(d) && side && side.outs) || []).map((o) => o.id).join(',');
      }).join('|');
      if (key !== shape) {
        shape = key;
        rows.clear();
        list.textContent = '';
        if (tab === 'out') list.append(selfRow);
        for (const d of devs) {
          const r = deviceRow(d);
          rows.set(d.id, r);
          list.append(r.el);
        }
      }
      selfName.textContent = me;
      selfCheck.checked = !a.muteLocal;
      for (const d of devs) rows.get(d.id).update(d);
      empty.hidden = devs.length > 0;
      empty.textContent = t('No computer is connected.');
      syncRow.hidden = tab !== 'out' || !devs.length;
      syncSw.set(!!a.sync);
      syncRow.setHint(a.sync && !a.muteLocal ? t('Every computer plays 0.2 s late, so speakers in one room play together. {me}’s own speakers play without the delay.') : t('Every computer plays 0.2 s late, so speakers in one room play together.'));
    }

    return {
      el,
      update(state) {
        s = state;
        render();
      },
    };
  };
})();
