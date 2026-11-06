// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web tab: Connect iPhone & iPad over Wi-Fi or USB-C cable.
// Web portal (tdweb) for file drops, clipboard sync, iPad second monitor,
// and AirPlay receiver (tdplay) for screen mirroring.
// Fully modular: zero processes and zero network ports open until enabled.
'use strict';

(() => {
  const tr = (text, vars) => (window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)));

  UI.tab({
    id: 'web',
    group: 'More',
    order: 78,
    title: tr('TwinDesk Web'),
    icon: 'web',
    color: 'linear-gradient(#0a84ff, #0071e3)',
    desc: tr('Connect iPhone, iPad, PC or phone browser over Wi-Fi or USB-C cable for file drops, clipboard sync, and screen sharing.'),
    badge: (s) => (s.web && s.web.airplayActive ? 'warn' : s.web && s.web.enabled ? 'on' : ''),
    master: {
      get: (s) => !!(s.web && s.web.enabled),
      set: (v) => UI.api.setWeb({ enabled: v }),
    },
    build(body) {
      const { api, el } = UI;

      // Card 1: Web Portal (tdweb)
      const portalSw = UI.switch((v) => api.setWeb({ portal: v }), { label: tr('Web Portal (tdweb)') });
      const portalRow = UI.row(tr('Web Portal'), tr('Serve browser client for phones, tablets, and computers'), [portalSw]);

      // Pair Code / Token Display (Prominent for PCs without cameras)
      const pairCodeVal = el('span', { class: 'code', style: 'font-size: 16px; font-weight: 700; letter-spacing: 2px; padding: 4px 10px; background: var(--track-off); border-radius: 6px;' }, ['------']);
      const copyCodeBtn = UI.button(tr('Copy Code'), () => {
        if (pairCodeVal.textContent && pairCodeVal.textContent !== '------' && api.copyText) {
          api.copyText(pairCodeVal.textContent);
        }
      }, 'small');
      const copyUrlBtn = UI.button(tr('Copy Web Link'), () => {
        if (lastActiveUrl && api.copyText) {
          api.copyText(lastActiveUrl);
        }
      }, 'small');
      const pairCodeRow = UI.row(tr('Pair Code'), tr('Enter this 6-character code on any PC, laptop or phone browser to connect'), [pairCodeVal, copyCodeBtn, copyUrlBtn]);

      const wifiUrlEl = el('span', { class: 'code', text: '—' });
      const cableUrlEl = el('span', { class: 'code', text: 'Not connected' });
      const cableBadge = el('span', { class: 'pill', text: tr('Cable disconnected') });

      const qrContainer = el('div', { class: 'qr-wrap', style: 'margin-top: 12px; display: flex; flex-direction: column; align-items: center; gap: 8px;' });
      const qrLabel = el('div', { class: 'hint', text: tr('Scan with iPhone or iPad camera to connect:') });
      const qrCanvasWrap = el('div', { class: 'qr-canvas' });
      qrContainer.append(qrLabel, qrCanvasWrap);

      const wifiRow = UI.row(tr('Wi-Fi Link'), tr('Open in browser on the same Wi-Fi network'), [wifiUrlEl]);
      const cableRow = UI.row(tr('USB-C Cable Link'), tr('Direct high-speed link with zero lag and offline support'), [cableUrlEl, cableBadge]);

      const portalCard = UI.card(tr('TwinDesk Web Portal'), [
        portalRow,
        pairCodeRow,
        wifiRow,
        cableRow,
        qrContainer,
      ]);

      // Card 2: Connected Web Devices
      const devList = el('div', { class: 'history', style: 'padding: 4px 0;' });
      const emptyDev = el('div', { class: 'hub-empty', text: tr('No web devices connected yet. Enter the Pair Code or scan the QR code to pair.') });
      devList.append(emptyDev);
      const devicesCard = UI.card(tr('Connected Web Devices'), [devList]);

      // Card 3: AirPlay Receiver (tdplay)
      const airplaySw = UI.switch((v) => api.setWeb({ airplay: v }), { label: tr('AirPlay Receiver (tdplay)') });
      const airplayStatus = el('span', { class: 'hint', text: tr('Stopped') });
      const airplayRow = UI.row(tr('AirPlay Receiver'), tr('Mirror iPhone or iPad screen here via Control Center'), [airplaySw]);
      const airplayInfoRow = UI.row(tr('Status'), tr('Appears under Screen Mirroring on your Apple device'), [airplayStatus]);

      const airplayCard = UI.card(tr('AirPlay Screen Mirroring'), [
        airplayRow,
        airplayInfoRow,
      ]);

      body.append(portalCard, devicesCard, airplayCard);

      let lastQrText = '';
      let lastActiveUrl = '';

      return {
        update(s) {
          const w = s.web || {};
          portalSw.set(!!w.portal);
          airplaySw.set(!!w.airplay);

          const code = (w.pairCode || (w.urls && w.urls.token) || '').toUpperCase();
          pairCodeVal.textContent = code || '------';
          copyCodeBtn.disabled = !code;

          if (w.portal && w.urls) {
            wifiUrlEl.textContent = w.urls.wifiUrl || tr('Wi-Fi unavailable');

            if (w.urls.cableConnected && w.urls.cableUrl) {
              cableUrlEl.textContent = w.urls.cableUrl;
              cableBadge.textContent = tr('Cable Connected');
              cableBadge.className = 'pill good';
            } else {
              cableUrlEl.textContent = tr('Connect USB-C / Lightning cable for instant speed');
              cableBadge.textContent = tr('No Cable');
              cableBadge.className = 'pill muted';
            }

            const activeUrl = (w.urls.cableConnected && w.urls.cableUrl) ? w.urls.cableUrl : w.urls.wifiUrl;
            lastActiveUrl = activeUrl || '';
            copyUrlBtn.disabled = !lastActiveUrl;

            if (activeUrl && activeUrl !== lastQrText && window.Qr) {
              lastQrText = activeUrl;
              qrCanvasWrap.replaceChildren(window.Qr.canvas(activeUrl, 160));
              qrContainer.hidden = false;
            }
          } else {
            wifiUrlEl.textContent = '—';
            cableUrlEl.textContent = '—';
            cableBadge.textContent = tr('Disabled');
            cableBadge.className = 'pill muted';
            qrContainer.hidden = true;
            lastActiveUrl = '';
            copyUrlBtn.disabled = true;
          }

          // Render connected web devices list
          const devs = s.webDevices || [];
          if (!devs.length) {
            devList.replaceChildren(emptyDev);
          } else {
            const rows = devs.map((d) => {
              const active = !!d.active || (s.activeWebDevice && s.activeWebDevice.id === d.id);
              const nameEl = el('span', { style: 'font-weight: 600;' }, [d.name]);
              const subEl = el('span', { class: 'hint', style: 'margin-left: 8px;' }, [d.sub || tr('Connected')]);
              const pill = el('span', { class: `pill ${active ? 'good' : 'muted'}`, style: 'margin-left: 8px;' }, [active ? tr('Active') : tr('Standby')]);

              const selectBtn = UI.button(active ? tr('Selected') : tr('Select'), () => {
                if (api.selectWebDevice) api.selectWebDevice(d.id);
                if (window.UI && window.UI.go) window.UI.go('overview');
              }, 'small' + (active ? ' primary' : ''));
              selectBtn.disabled = active;

              const discBtn = UI.button(tr('Disconnect'), () => {
                if (api.disconnectWebClient) api.disconnectWebClient(d.id);
              }, 'small');

              return UI.row(nameEl, subEl, [pill, selectBtn, discBtn], { literalHint: true });
            });
            devList.replaceChildren(...rows);
          }

          if (w.airplay) {
            if (w.airplayClient) {
              airplayStatus.textContent = tr('Streaming from {name}', { name: w.airplayClient.name || 'iPhone' });
            } else {
              airplayStatus.textContent = tr('Listening (ready for Screen Mirroring in Control Center)');
            }
          } else {
            airplayStatus.textContent = tr('Stopped (0 MB RAM)');
          }
        },
      };
    },
  });
})();
