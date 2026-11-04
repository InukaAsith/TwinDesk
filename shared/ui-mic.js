// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Audio › Microphone (shared/mic.js), the same card on every desktop: this computer's microphone on
// the other one, and the other's here, each its own switch. Here, the other's plays into the
// TwinDesk Microphone (Linux) or a virtual audio cable (Windows, macOS), which apps pick as their
// microphone. With a phone: only the phone's microphone here (phoneview.js, kind 'mic').
// UI.micCard() → {el, update(state)}.
'use strict';

(function () {
  UI.micCard = function micCard() {
    const t = (...a) => I18n.t(...a);
    const api = UI.api;
    const sendSw = UI.switch((v) => api.setAudio({ micSend: v }), { label: t('Use {me}’s microphone on {name}') });
    const recvSw = UI.switch((v) => api.setAudio({ micReceive: v }), { label: t('Use {name}’s microphone on {me}') });
    const input = UI.select([{ value: '', label: t('Default microphone') }], (v) => api.setAudio({ micDevice: v }));
    const output = UI.select([{ value: '', label: t('Found by itself') }], (v) => api.setAudio({ micOut: v }));
    const sendRow = UI.row(t('Use {me}’s microphone on {name}'), '', [sendSw]);
    const inRow = UI.row(t('Microphone'), '', [input]);
    const recvRow = UI.row(t('Use {name}’s microphone on {me}'), '', [recvSw]);
    const outRow = UI.row(t('Plays into'), '', [output]);
    const el = UI.card(t('Microphone'), [sendRow, inRow, recvRow, outRow]);

    function update(s) {
      const a = s.audio || {};
      const m = a.mic || {};
      const phone = !!(UI.isPhone && UI.isPhone(s));
      sendSw.set(!!a.micSend);
      recvSw.set(!!a.micReceive);
      sendRow.hidden = phone; // a phone takes no microphone from here
      inRow.hidden = !a.micSend || phone;
      outRow.hidden = !a.micReceive || !!m.linux;
      input.options([{ value: '', label: t('Default microphone') }, ...(m.inputs || []).filter((d) => d.id && d.id !== 'default').map((d) => ({ value: d.id, label: d.label }))]);
      output.options([{ value: '', label: t('Found by itself') }, ...(m.outputs || []).filter((d) => d.id && d.id !== 'default').map((d) => ({ value: d.id, label: d.label }))]);
      input.set(a.micDevice || '');
      output.set(a.micOut || '');
      const device = UI.peer(s).name;
      sendRow.setHint(!a.micSend ? t('Calls and recordings on {name} hear this microphone')
        : m.error && /microphone/i.test(m.error) && !m.sending ? m.error
          : !m.peerAccepts ? t('Turned off on {device}', { device })
            : m.sending ? t('In use on {device}', { device }) : t('Connecting…'));
      if (phone) {
        const ready = ((s.phone || {}).bridge || {}).state === 'ready';
        recvRow.setHint(!ready ? t('Needs wireless debugging (Phone page) and Android 11 or later')
          : m.linux ? t('Apps here pick “TwinDesk Microphone”. Android 11 or later')
            : t('Plays into a virtual audio cable (VB-CABLE, BlackHole) when one is installed, else the speakers. Android 11 or later'));
        return;
      }
      recvRow.setHint(!a.micReceive ? (m.linux || a.micReceive === undefined ? t('Apps here pick it as “TwinDesk Microphone”') : t('Apps here pick it through a virtual audio cable'))
        : m.linux ? (m.receiving ? t('Live: apps pick “TwinDesk Microphone”') : t('Apps pick “TwinDesk Microphone”. Waiting for {device}', { device }))
          : m.into ? (m.receiving ? t('Live into {output}: apps pick its other end as the microphone', { output: m.into }) : t('Into {output}. Waiting for {device}', { output: m.into, device }))
            : t('No virtual audio cable found: it plays on the speakers. Install VB-CABLE (Windows) or BlackHole (macOS) and apps can pick it as a microphone'));
    }
    return { el, update };
  };
})();
