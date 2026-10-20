// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › Mac → PC: this Mac's screen on the PC (Monitor 2). Extend/Mirror, which display, the TwinDesk virtual display, stream quality,
// input from Monitor 2, live stats.
'use strict';

UI.tab({
  id: 'share',
  group: 'Display',
  order: 10,
  title: 'Share screen',
  heading: '{me} on {name}',
  icon: 'display',
  desc: 'Use {me} as a second screen for {name}.',
  color: 'linear-gradient(#5ac8fa, #0a84ff)',
  master: { get: (s) => s.sharing && s.sharing.on, set: (v) => UI.api.setSharing(v) },
  badge: (s) => (s.sharing && s.sharing.on ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const PRESETS = [
      { label: '1280 × 720', width: 1280, height: 720, hiDPI: false },
      { label: '1920 × 1080', width: 1920, height: 1080, hiDPI: false },
      { label: '2560 × 1440', width: 2560, height: 1440, hiDPI: false },
      { label: '1920 × 1080 HiDPI (3840 × 2160 px)', width: 1920, height: 1080, hiDPI: true },
      { label: '2560 × 1440 HiDPI (5120 × 2880 px)', width: 2560, height: 1440, hiDPI: true },
    ];
    const STATUS = {
      off: 'Off', starting: 'Starting…', 'waiting for answer': 'Waiting for {name}…', new: 'Connecting…',
      connecting: 'Connecting…', live: 'Live', 'no viewer': 'Ready — starts when {name} opens it', 'nothing connected': 'Waiting for {name}', 'no display to share': 'No display to share', disconnected: 'Reconnecting…', failed: 'Retrying…', closed: 'Closed',
    };

    const helperNote = UI.note('bad', 'Something went wrong in the background. Restart TwinDesk.');

    const mode = UI.segmented([
      { value: 'extend', label: 'Extend' },
      { value: 'mirror', label: 'Mirror' },
    ], (v) => api.setDisplayMode(v));
    const modeRow = UI.row('Mode', '', [mode]);
    const display = UI.select([], (v) => api.selectDisplay(v === 'virtual' ? null : Number(v)));
    const displayRow = UI.row('Display', '', [display]);

    const virtOn = UI.switch((v) => api.setVirtual({ enabled: v }), { label: 'Virtual display' });
    const preset = UI.select(PRESETS.map((p, i) => ({ value: i, label: p.label })), () => { presetDirty = true; applyBtn.disabled = false; });
    let presetDirty = false;
    const applyBtn = UI.button('Apply', () => {
      const p = PRESETS[Number(preset.el.value)];
      presetDirty = false;
      api.setVirtual({ enabled: true, width: p.width, height: p.height, hiDPI: p.hiDPI });
    }, 'small');
    const virtRow = UI.row('TwinDesk virtual display', '', [virtOn]);
    const sizeRow = UI.row('Size', '', [preset, applyBtn]);

    const streamSize = UI.select([
      { value: 1080, label: '1080p, fastest' },
      { value: 1440, label: '1440p, sharper' },
      { value: 0, label: 'Full size' },
    ], (v) => api.setStreamMaxHeight(Number(v)));
    const quality = UI.select([
      { value: 10, label: 'Low, 10 Mbps' },
      { value: 20, label: 'Medium, 20 Mbps' },
      { value: 30, label: 'High, 30 Mbps' },
      { value: 50, label: 'Best, 50 Mbps (wired)' },
      { value: 80, label: 'Max, 80 Mbps (wired)' },
    ], (v) => api.setBitrate(Number(v)));

    const paceRow = UI.paceRow();
    const remoteSw = UI.switch((v) => api.setSharingOpts({ remote: v }), { label: 'Remote start' });
    const remoteRow = UI.row('Let {name} start and switch this screen', 'Open it on {name} — no need to touch {me}', [remoteSw]);

    const soundSw = UI.switch((v) => api.setScreenSound(v), { label: 'Share sound with the screen' });
    const soundRow = UI.row('Include sound', '', [soundSw]);
    const inputSw = UI.switch((v) => api.setStreamInput(v), { label: 'Receive input' });
    const inputRow = UI.row('Let {name} use {me} in its window', '', [inputSw]);

    const stats = {
      status: UI.row('Status', ''),
      display: UI.row('Display', ''),
      picture: UI.row('Picture', ''),
      rate: UI.row('Speed', ''),
      rtt: UI.row('Round trip', ''),
      codec: UI.row('Codec', ''),
      encoder: UI.row('Encoder', ''),
      encode: UI.row('Encode time', ''),
    };
    const statVals = Object.fromEntries(Object.entries(stats).map(([k, r]) => {
      const v = el('span', { class: 'value' });
      r.querySelector('.controls').append(v);
      return [k, v];
    }));

    // This Mac's displays as the OS arranges them, and what each connected device gets.
    const map = el('div', { class: 'screen-map' });
    map.style.cssText = 'position:relative;height:120px;margin:8px 0';
    const targetsBox = el('div', { class: 'screen-targets' });
    let targetsKey = '';
    const drawMap = (displays, targets) => {
      map.textContent = '';
      if (!displays.length) return;
      const x0 = Math.min(...displays.map((d) => d.x)), y0 = Math.min(...displays.map((d) => d.y));
      const w = Math.max(...displays.map((d) => d.x + d.w)) - x0, h = Math.max(...displays.map((d) => d.y + d.h)) - y0;
      const k = Math.min(100 / h, (map.clientWidth || 480) / w, 1);
      for (const d of displays) {
        const who = targets.filter((t) => t.mode === 'mirror' && t.displayId === d.id).map((t) => t.name);
        const box = el('div', { text: [d.name + (d.primary ? ' (main)' : ''), d.w + ' × ' + d.h].concat(who.length ? ['→ ' + who.join(', ')] : []).join(String.fromCharCode(10)) });
        box.style.cssText = `position:absolute;box-sizing:border-box;border:1px solid var(--accent,#0a84ff);border-radius:4px;font-size:11px;white-space:pre;overflow:hidden;padding:2px 4px;opacity:${who.length ? 1 : 0.6};`
          + `left:${(d.x - x0) * k}px;top:${(d.y - y0) * k}px;width:${d.w * k}px;height:${d.h * k}px`;
        map.append(box);
      }
      map.style.height = h * k + 'px';
    };
    const drawTargets = (st) => {
      const key = JSON.stringify([st.targets, st.displays]);
      if (key === targetsKey) return;
      targetsKey = key;
      targetsBox.textContent = '';
      for (const t of st.targets) {
        const choices = [{ value: 'default', label: 'As set above' }, { value: 'none', label: 'Off' }, { value: 'virtual', label: 'Virtual display' },
          ...st.displays.map((d) => ({ value: 'mirror:' + d.id, label: 'Mirror ' + d.name }))];
        const sel = UI.select(choices, (v) => api.setStreamTarget(t.id, v.startsWith('mirror:') ? { mode: 'mirror', displayId: v.slice(7) } : { mode: v }));
        sel.set(t.mode === 'mirror' ? 'mirror:' + t.displayId : t.mode);
        targetsBox.append(UI.row(t.name, '', [sel]));
      }
    };
    const screens = UI.card('Displays', [map, targetsBox]);

    body.append(
      helperNote,
      screens,
      UI.card('Screen', [modeRow, displayRow]),
      UI.card('Virtual display', [virtRow, sizeRow]),
      UI.card('Picture', [
        UI.row('Resolution', '', [streamSize]),
        UI.row('Quality', '', [quality]),
        paceRow,
      ]),
      UI.card('Sound and control', [remoteRow, soundRow, inputRow], { cls: 'keep-on' }),
      UI.card('Details', Object.values(stats), { cls: 'keep-on' }),
    );

    return (s) => {
      helperNote.hidden = !!(s.helper && s.helper.running);
      const sh = s.sharing;
      if (!sh) return;
      const sd = s.stream && s.stream.displays;
      screens.hidden = !(sd && sd.length);
      if (sd && sd.length) {
        drawMap(sd, s.stream.targets || []);
        targetsBox.hidden = !s.stream.targets || s.stream.targets.length < 2; // one device: the cards below do it all
        if (!targetsBox.hidden) drawTargets(s.stream);
      }
      mode.set(s.displayMode);
      modeRow.setHint({ extend: 'Shows the TwinDesk virtual display', mirror: 'Shows {me}’s main screen', custom: '' }[s.displayMode]);

      display.options([
        { value: 'virtual', label: 'TwinDesk virtual display' },
        ...sh.displays.filter((d) => !d.virtual).map((d) => ({ value: d.id, label: `${d.label}${d.primary ? ' (main)' : ''}` })),
      ]);
      const picked = sh.displays.find((d) => d.id === sh.displayId && !d.virtual);
      display.set(picked ? picked.id : 'virtual');

      const v = sh.virtual;
      virtOn.set(v.enabled);
      if (!presetDirty) {
        const i = PRESETS.findIndex((p) => p.width === v.width && p.height === v.height && p.hiDPI === !!v.hiDPI);
        preset.set(i < 0 ? 1 : i);
        applyBtn.disabled = true;
      }
      const vd = sh.displays.find((d) => d.virtual);
      virtRow.setHint(v.error ? `Couldn’t create it: ${v.error}` : vd ? `On, ${vd.width} × ${vd.height}${vd.pixelWidth !== vd.width ? ` (${vd.pixelWidth} × ${vd.pixelHeight} px)` : ''}` : v.enabled ? 'On while sharing' : '');

      streamSize.set(sh.streamMaxHeight || 0);
      quality.set(sh.bitrateMbps);

      soundSw.set(sh.audio);
      remoteSw.set(sh.remote !== false);
      paceRow.render(s);
      inputSw.set(s.streamInput);
      const c = s.client;

      const st = s.stream || { status: 'off' };
      const live = st.status === 'live';
      const p = UI.peer(s);
      statVals.status.textContent = !sh.on ? 'Off' : !c ? `Waiting for ${p.name}` : UI.fill(STATUS[st.status] || st.status);
      const shown = sh.displays.find((d) => d.id === sh.targetId);
      statVals.display.textContent = shown ? `${shown.virtual ? 'TwinDesk virtual display' : shown.label} · ${shown.pixelWidth} × ${shown.pixelHeight}` : '';
      statVals.picture.textContent = live ? `${st.width} × ${st.height} · ${st.fps} fps` : '';
      statVals.rate.textContent = live ? `${st.mbps} Mbps${st.targetMbps ? ` of ${st.targetMbps}` : ''}` : '';
      statVals.rtt.textContent = c && c.rttMs != null ? `${c.rttMs} ms` : '';
      statVals.codec.textContent = live && st.codec ? st.codec : '';
      statVals.encoder.textContent = live && st.encoder ? st.encoder : '';
      statVals.encode.textContent = live && st.encodeMs != null ? `${st.encodeMs} ms${st.limit && st.limit !== 'none' ? ` · limited by ${st.limit}` : ''}` : '';
      for (const k of ['codec', 'encoder', 'encode', 'rtt', 'display']) stats[k].hidden = !statVals[k].textContent;
    };
  },
});
