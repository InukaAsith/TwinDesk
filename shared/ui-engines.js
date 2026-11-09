// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Settings › General › Advanced › Engines in use (Mac, PC and Linux), while connected: the link, how
// input travels (tdv2 native or JS, tdv1), how files go (fx2, fx, file.chunk) and why a fallback,
// the files engine, and the screen's codec and encoder. state.engines from shared/engines.js.
// UI.enginesRows() → {rows, update(state)}.
'use strict';

UI.enginesRows = () => {
  const t = (...args) => (typeof I18n === 'undefined' ? args[0] : I18n.t(...args));
  const value = () => UI.el('span', { class: 'value', attrs: { 'data-literal': '' } });
  const make = (label) => {
    const v = value();
    const row = UI.row(label, '', []);
    row.querySelector('.controls').append(v);
    row.hidden = true;
    return { row, v };
  };
  const head = make(t('Engines in use'));
  head.row.setHint(t('What this session uses now, and the way back when a faster one can’t be'));
  const link = make(t('Connection'));
  const input = make(t('Input'));
  const files = make(t('Files'));
  const engine = make(t('Files engine'));
  const screen = make(t('Screen'));
  const all = [head, link, input, files, engine, screen];

  const LINK = { ble: () => t('Bluetooth'), direct: () => t('Wi-Fi Direct'), hotspot: () => t('Hotspot') };
  const WHY_INPUT = { setting: () => t('TCP chosen above'), bluetooth: () => t('through Bluetooth'), peer: () => t('the other app can’t') };
  const WHY_FILES = {
    peer: () => t('the other app can’t'), bluetooth: () => t('through Bluetooth'), failed: () => t('the faster way failed this session'),
    off: () => t('off on this computer'), engine: () => t('the files engine isn’t up'),
  };
  const WAY = { fx2: 'fx2', fx: 'fx', chunk: 'file.chunk' };
  const ENGINE = {
    running: () => t('Running'), 'in-process': () => t('Running'), starting: () => t('Starting…'),
    stopped: () => t('Stopped until needed'), failed: () => t('Stopped (files go the fx way)'), off: () => t('Off'),
  };

  return {
    rows: all.map((x) => x.row),
    update(s) {
      const e = s && s.engines;
      for (const x of all) x.row.hidden = !e;
      if (!e) return;
      const l = e.link || {};
      const kind = LINK[l.kind] ? LINK[l.kind]() : l.lan || t('Network');
      link.v.textContent = l.address ? `${kind} · ${l.address}` : kind;

      const i = e.input || {};
      if (i.proto === 'tdv2') {
        input.v.textContent = `tdv2 (UDP, ${i.native ? t('native') : 'JS'})${i.up && i.rttMs != null ? ` · ${i.rttMs} ms` : ''}`;
        input.row.setHint(i.up ? '' : t('Waiting for the lane: input goes by TCP meanwhile'));
      } else {
        input.v.textContent = 'tdv1 (TCP)';
        input.row.setHint(WHY_INPUT[i.why] ? WHY_INPUT[i.why]() : '');
      }

      const f = e.files || {};
      files.v.textContent = `${WAY[f.next] || f.next}${f.plain ? ` · ${t('unencrypted')}` : ''}`;
      const why = (WHY_FILES[f.why] ? WHY_FILES[f.why]() : '') + (f.detail ? ` (${f.detail})` : ''); // the error that made it fall back (#143)
      const last = f.last ? t('Last file: {way}, {dir}', { way: WAY[f.last.way] || f.last.way, dir: f.last.dir === 'recv' ? t('received') : t('sent') }) : '';
      files.row.setHint([why, last].filter(Boolean).join(' · '));

      engine.v.textContent = ENGINE[e.engine] ? ENGINE[e.engine]() : String(e.engine || '');
      engine.row.setHint(e.engineWhy ? t('In TwinDesk itself: {why}', { why: e.engineWhy }) : '');
      screen.row.hidden = !e.screen;
      if (e.screen) screen.v.textContent = [e.screen.codec, e.screen.encoder].filter(Boolean).join(' · ');
    },
  };
};
