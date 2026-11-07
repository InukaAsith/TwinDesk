// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › Mac → PC: this Mac's screen on the PC (Monitor 2). Extend/Mirror, which display, the TwinDesk virtual display, stream quality,
// input from Monitor 2, live stats.
'use strict';

UI.tab({
  id: 'share',
  group: 'Display',
  order: 10,
  title: I18n.t('Share screen'),
  heading: I18n.t('{me} on {name}'),
  icon: 'display',
  desc: I18n.t('Use {me} as a second screen for {name}.'),
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
      off: I18n.t('Off'), starting: I18n.t('Starting…'), 'waiting for answer': I18n.t('Waiting for {name}…'), new: I18n.t('Connecting…'),
      connecting: I18n.t('Connecting…'), live: I18n.t('Live'), 'no viewer': I18n.t('Ready — starts when {name} opens it'), 'waiting for Wi-Fi': I18n.t('Waiting for Wi-Fi'), 'nothing connected': I18n.t('Waiting for {name}'), 'no display to share': I18n.t('No display to share'), disconnected: I18n.t('Reconnecting…'), failed: I18n.t('Retrying…'), closed: I18n.t('Closed'),
    };

    const helperNote = UI.note('bad', I18n.t('Something went wrong in the background. Restart TwinDesk.'));

    const mode = UI.segmented([
      { value: 'extend', label: I18n.t('Extend') },
      { value: 'mirror', label: I18n.t('Mirror') },
    ], (v) => api.setDisplayMode(v));
    const modeRow = UI.row(I18n.t('Mode'), '', [mode]);
    const display = UI.select([], (v) => api.selectDisplay(v === 'virtual' ? null : Number(v)));
    const displayRow = UI.row(I18n.t('Display'), '', [display]);

    const virtOn = UI.switch((v) => api.setVirtual({ enabled: v }), { label: I18n.t('Virtual display') });
    const preset = UI.select(PRESETS.map((p, i) => ({ value: i, label: p.label })), () => { presetDirty = true; applyBtn.disabled = false; });
    let presetDirty = false;
    const applyBtn = UI.button(I18n.t('Apply'), () => {
      const p = PRESETS[Number(preset.el.value)];
      presetDirty = false;
      api.setVirtual({ enabled: true, width: p.width, height: p.height, hiDPI: p.hiDPI });
    }, 'small');
    const virtRow = UI.row(I18n.t('TwinDesk virtual display'), '', [virtOn], { literalHint: true });
    const sizeRow = UI.row(I18n.t('Size'), '', [preset, applyBtn]);

    const streamSize = UI.select([
      { value: 1080, label: I18n.t('1080p, fastest') },
      { value: 1440, label: I18n.t('1440p, sharper') },
      { value: 2160, label: I18n.t('4K (2160p), sharpest') },
      { value: 0, label: I18n.t('Full size') },
    ], (v) => api.setStreamMaxHeight(Number(v)));
    const quality = UI.select([
      { value: 10, label: I18n.t('Low, 10 Mbps') },
      { value: 20, label: I18n.t('Medium, 20 Mbps') },
      { value: 30, label: I18n.t('High, 30 Mbps') },
      { value: 50, label: I18n.t('Best, 50 Mbps (wired)') },
      { value: 80, label: I18n.t('Max, 80 Mbps (wired)') },
    ], (v) => api.setBitrate(Number(v)));

    const paceRow = UI.paceRow();
    // Frame rate: the display's refresh rate unless capped (stream.js; a change starts a new session).
    const frameRate = UI.select([
      { value: 0, label: I18n.t('Match the display') },
      { value: 60, label: I18n.t('60 fps') },
      { value: 30, label: I18n.t('30 fps, lighter') },
    ], (v) => api.setSharingOpts({ fps: Number(v) }));
    const codecRow = UI.codecRow((v) => api.setSharingOpts({ codec: v }));
    const remoteSw = UI.switch((v) => api.setSharingOpts({ remote: v }), { label: I18n.t('Remote start') });
    const remoteRow = UI.row(I18n.t('Let {name} start and switch this screen'), I18n.t('Open it on {name} — no need to touch {me}'), [remoteSw]);

    const soundSw = UI.switch((v) => api.setScreenSound(v), { label: I18n.t('Share sound with the screen') });
    const soundRow = UI.row(I18n.t('Include sound'), '', [soundSw]);
    const inputSw = UI.switch((v) => api.setStreamInput(v), { label: I18n.t('Receive input') });
    const inputRow = UI.row(I18n.t('Let {name} use {me} in its window'), '', [inputSw]);

    const stats = {
      status: UI.row(I18n.t('Status'), ''),
      display: UI.row(I18n.t('Display'), ''),
      picture: UI.row(I18n.t('screen.picture'), ''),
      rate: UI.row(I18n.t('Speed'), ''),
      rtt: UI.row(I18n.t('Round trip'), ''),
      codec: UI.row(I18n.t('Codec'), ''),
      encoder: UI.row(I18n.t('Encoder'), ''),
      encode: UI.row(I18n.t('Encode time'), ''),
    };
    const statVals = Object.fromEntries(Object.entries(stats).map(([k, r]) => {
      const v = el('span', { class: 'value' });
      r.querySelector('.controls').append(v);
      return [k, v];
    }));

    body.append(
      helperNote,
      UI.card(I18n.t('Screen'), [modeRow, displayRow]),
      UI.card(I18n.t('Virtual display'), [virtRow, sizeRow]),
      UI.card(I18n.t('screen.picture'), [
        UI.row(I18n.t('Resolution'), '', [streamSize]),
        UI.row(I18n.t('Quality'), '', [quality]),
        UI.row(I18n.t('Frame rate'), '', [frameRate]),
        paceRow,
        codecRow,
      ]),
      UI.card(I18n.t('Sound and control'), [remoteRow, soundRow, inputRow], { cls: 'keep-on' }),
      UI.card(I18n.t('Details'), Object.values(stats), { cls: 'keep-on' }),
    );

    return (s) => {
      helperNote.hidden = !!(s.helper && s.helper.running);
      const sh = s.sharing;
      if (!sh) return;
      mode.set(s.displayMode);
      modeRow.setHint({ extend: I18n.t('Shows the TwinDesk virtual display'), mirror: I18n.t('Shows {me}’s main screen'), custom: '' }[s.displayMode]);

      display.options([
        { value: 'virtual', label: I18n.t('TwinDesk virtual display') },
        ...sh.displays.filter((d) => !d.virtual).map((d) => ({ value: d.id, label: UI.monitorLabel(d.label) + (d.primary ? I18n.t(' (main)') : '') })),
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
      virtRow.setHint(v.error ? I18n.t('Couldn’t create it: {error}', { error: v.error }) : vd ? I18n.t('On, {width} × {height}{pixels}', { width: vd.width, height: vd.height, pixels: vd.pixelWidth !== vd.width ? ` (${vd.pixelWidth} × ${vd.pixelHeight} px)` : '' }) : v.enabled ? I18n.t('On while sharing') : '');

      streamSize.set(sh.streamMaxHeight || 0);
      quality.set(sh.bitrateMbps);
      frameRate.set(sh.fps || 0);

      soundSw.set(sh.audio);
      remoteSw.set(sh.remote !== false);
      paceRow.render(s);
      codecRow.render(sh.codec);
      inputSw.set(s.streamInput);
      const c = s.client;

      const st = s.stream || { status: 'off' };
      const live = st.status === 'live';
      const p = UI.peer(s);
      statVals.status.textContent = !sh.on ? I18n.t('Off') : !c ? I18n.t('Waiting for {device}', { device: p.name }) : UI.fill(STATUS[st.status] || st.status);
      const shown = sh.displays.find((d) => d.id === sh.targetId);
      statVals.display.textContent = shown ? `${shown.virtual ? I18n.t('TwinDesk virtual display') : UI.monitorLabel(shown.label)} · ${shown.pixelWidth} × ${shown.pixelHeight}` : '';
      statVals.picture.textContent = live ? `${st.width} × ${st.height} · ${st.fps} fps` : '';
      statVals.rate.textContent = live ? (st.targetMbps ? I18n.t('{mbps} Mbps of {targetMbps}', { mbps: st.mbps, targetMbps: st.targetMbps }) : `${st.mbps} Mbps`) : '';
      statVals.rtt.textContent = c && c.rttMs != null ? `${c.rttMs} ms` : '';
      statVals.codec.textContent = live && st.codec ? st.codec : '';
      statVals.encoder.textContent = live && st.encoder ? st.encoder : '';
      statVals.encode.textContent = live && st.encodeMs != null ? `${st.encodeMs} ms` + (st.limit && st.limit !== 'none' ? I18n.t(' · limited by {limit}', { limit: I18n.t(st.limit) }) : '') : '';
      for (const k of ['codec', 'encoder', 'encode', 'rtt', 'display']) stats[k].hidden = !statVals[k].textContent;
    };
  },
});
