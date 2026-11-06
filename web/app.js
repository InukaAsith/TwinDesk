// TwinDesk Web App — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mobile (Jetpack Compose Ui.kt clone) and Desktop (TwinDesk shell clone) client logic.
// Zero emojis — pure SVG iconography throughout.
'use strict';

(() => {
  const q = new URLSearchParams(location.search);
  let token = (q.get('token') || localStorage.getItem('td_pair_code') || '').toUpperCase();

  // Auto-detect client device identity
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
  const isAndroid = /Android/i.test(ua);
  const isPhone = /iPhone/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua));
  const isTablet = /iPad/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua)) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const clientKind = (isPhone || isTablet) ? 'phone' : 'computer';
  const clientOs = isIOS ? 'ios' : isAndroid ? 'android' : /Windows/i.test(ua) ? 'win' : /Macintosh/i.test(ua) ? 'mac' : 'linux';
  const clientDefaultName = isPhone ? (isIOS ? 'iPhone' : 'Android Phone') : isTablet ? (isIOS ? 'iPad' : 'Tablet') : 'Web Device';

  let clientId = localStorage.getItem('td_client_id');
  if (!clientId) {
    clientId = 'web-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('td_client_id', clientId);
  }

  // DOM Elements
  const pages = document.querySelectorAll('.page');
  const desktopNavItems = document.querySelectorAll('.nav-item');
  const mobileNavItems = document.querySelectorAll('.mob-nav-item');
  const moreItems = document.querySelectorAll('.more-item');

  const sidebarHost = document.getElementById('sidebar-host-name');
  const mobHost = document.getElementById('mob-host-name');
  const connHost = document.getElementById('conn-host-name');
  const heroHostName = document.getElementById('hero-host-name');
  const heroLocalName = document.getElementById('hero-local-name');
  const ctlHostName = document.getElementById('ctl-host-name');
  const ctlHostVersionLabel = document.getElementById('ctl-host-version-label');
  const btnShowScreenText = document.getElementById('btn-show-screen-text');
  const shareTarget = document.getElementById('share-target-name');
  const clipHostLabel = document.getElementById('clip-host-label');
  const clipPushLabel = document.getElementById('clip-push-label');
  const dropZoneTitle = document.getElementById('drop-zone-title');
  const sidebarClientName = document.getElementById('sidebar-client-name');
  const sidebarClientSub = document.getElementById('sidebar-client-sub');

  const sidebarDot = document.getElementById('sidebar-dot');
  const mobDot = document.getElementById('mob-peer-dot');
  const mobTransportText = document.getElementById('mob-transport-text');
  const heroBridgeText = document.getElementById('hero-bridge-text');
  const connTransportText = document.getElementById('conn-transport-text');
  const connStatus = document.getElementById('conn-status-label');
  const connToken = document.getElementById('conn-token');

  // Big Screen Hero Elements
  const btnShowScreenBig = document.getElementById('btn-show-screen-big');
  const btnHeroDisconnect = document.getElementById('btn-hero-disconnect');
  const btnHostRing = document.getElementById('btn-host-ring');
  const btnHostLock = document.getElementById('btn-host-lock');
  const btnHostSleep = document.getElementById('btn-host-sleep');
  const hostVolumeSlider = document.getElementById('host-volume-slider');
  const hostVolumeVal = document.getElementById('host-volume-val');

  // Big Files Action Elements
  const btnFilesSendBig = document.getElementById('btn-files-send-big');
  const btnFilesReceiveBig = document.getElementById('btn-files-receive-big');
  const filesDropZone = document.getElementById('files-drop-zone');
  const filesFilePicker = document.getElementById('files-file-picker');
  const filesTransfersList = document.getElementById('files-transfers-list');

  // Drop Page Elements
  const dropZone = document.getElementById('drop-zone');
  const filePicker = document.getElementById('file-picker');
  const btnAttach = document.getElementById('btn-attach');
  const transferCard = document.getElementById('transfer-card');
  const transferLabel = document.getElementById('transfer-label');
  const transferPct = document.getElementById('transfer-pct');
  const transferFill = document.getElementById('transfer-fill');
  const dropStream = document.getElementById('drop-stream');
  const dropText = document.getElementById('drop-text');
  const btnSend = document.getElementById('btn-send');
  const btnClipToggle = document.getElementById('btn-clip-toggle');

  // Clipboard Elements
  const clipRemoteText = document.getElementById('clip-remote-text');
  const btnCopyRemote = document.getElementById('btn-copy-remote');
  const clipLocalInput = document.getElementById('clip-local-input');
  const btnPushLocal = document.getElementById('btn-push-local');

  // Screen Options Elements
  const btnLaunchMonitor = document.getElementById('btn-launch-monitor');
  const selectResolution = document.getElementById('select-resolution');
  const qrCanvasBox = document.getElementById('qr-canvas-box');

  // Pair Code Elements
  const inputPairCode = document.getElementById('input-pair-code');
  const btnPairCode = document.getElementById('btn-pair-code');
  const btnCopyToken = document.getElementById('btn-copy-token');

  let currentHostName = 'Computer';
  let isCableConnected = false;
  let sendToClipboard = false;
  let ws = null;
  let wsReconnectTimer = null;

  const SVG_FILE = '<svg viewBox="0 0 20 20" class="icon-inline"><path d="M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15"></path></svg>';
  const SVG_DOWNLOAD = '<svg viewBox="0 0 20 20" class="icon-inline"><path d="M10 4v10 M6 9l5 5 5-5 M3 16h14"></path></svg>';

  // Display Local Name
  if (sidebarClientName) sidebarClientName.textContent = clientDefaultName;
  if (heroLocalName) heroLocalName.textContent = clientDefaultName;
  if (connToken) connToken.textContent = token || 'None';

  // ---- Navigation ----
  function switchTab(tabId) {
    if (!tabId) return;
    if (tabId === 'more' && window.innerWidth >= 768) {
      tabId = 'overview';
    }
    pages.forEach((p) => p.classList.toggle('active', p.id === `page-${tabId}`));
    desktopNavItems.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
    mobileNavItems.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (tabId === 'clipboard' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'clipboard-get' }));
    }
  }

  desktopNavItems.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  mobileNavItems.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  moreItems.forEach((item) => {
    item.addEventListener('click', () => switchTab(item.dataset.goto));
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 768) {
      const morePage = document.getElementById('page-more');
      if (morePage && morePage.classList.contains('active')) {
        switchTab('overview');
      }
    }
  });

  // ---- Pair Code Handling ----
  function applyPairCode(code) {
    code = (code || '').trim().toUpperCase();
    if (!code) return;
    token = code;
    localStorage.setItem('td_pair_code', code);
    const newUrl = new URL(location.href);
    newUrl.searchParams.set('token', code);
    history.replaceState(null, '', newUrl.toString());
    if (connToken) connToken.textContent = token;
    updateViewerLinks();
    fetchStatus();
    connectWs();
    renderQr();
  }

  if (btnPairCode && inputPairCode) {
    if (token) inputPairCode.value = token;
    btnPairCode.addEventListener('click', () => applyPairCode(inputPairCode.value));
    inputPairCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyPairCode(inputPairCode.value);
    });
  }

  if (btnCopyToken) {
    btnCopyToken.addEventListener('click', () => {
      if (token && navigator.clipboard) {
        navigator.clipboard.writeText(token).then(() => {
          btnCopyToken.textContent = 'Copied!';
          setTimeout(() => { btnCopyToken.textContent = 'Copy'; }, 1500);
        });
      }
    });
  }

  // ---- Resolution selection & monitor links ----
  function updateViewerLinks() {
    const res = selectResolution ? selectResolution.value : '1440';
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    params.set('res', res);
    const viewerUrl = `viewer.html?${params.toString()}`;

    if (btnLaunchMonitor) btnLaunchMonitor.href = viewerUrl;
    if (btnShowScreenBig) btnShowScreenBig.href = viewerUrl;
  }
  if (selectResolution) {
    selectResolution.addEventListener('change', updateViewerLinks);
  }
  updateViewerLinks();

  // ---- Host Identity & Transport ----
  function updateHostIdentity(name) {
    currentHostName = name || 'Computer';
    if (sidebarHost) sidebarHost.textContent = currentHostName;
    if (mobHost) mobHost.textContent = currentHostName;
    if (connHost) connHost.textContent = currentHostName;
    if (heroHostName) heroHostName.textContent = currentHostName;
    if (ctlHostName) ctlHostName.textContent = currentHostName;
    if (ctlHostVersionLabel) ctlHostVersionLabel.textContent = `TwinDesk on ${currentHostName}`;
    if (btnShowScreenText) btnShowScreenText.textContent = `Show ${currentHostName}'s screen`;
    if (shareTarget) shareTarget.textContent = currentHostName;
    if (clipHostLabel) clipHostLabel.textContent = currentHostName;
    if (clipPushLabel) clipPushLabel.textContent = currentHostName;
    if (dropZoneTitle) dropZoneTitle.textContent = `Drop files to send to ${currentHostName}`;
  }

  function updateTransport(cable) {
    isCableConnected = !!cable;
    const text = isCableConnected ? 'Cable · 1 ms' : 'Wi-Fi · 1 ms';
    if (mobTransportText) mobTransportText.textContent = text;
    if (heroBridgeText) heroBridgeText.textContent = text;
    if (connTransportText) connTransportText.textContent = isCableConnected ? 'USB-C Cable Link' : 'Local Wi-Fi Network';
    if (sidebarClientSub) sidebarClientSub.textContent = `Connected · ${isCableConnected ? 'Cable' : 'Wi-Fi'}`;
  }

  async function fetchStatus() {
    try {
      const res = await fetch(`/api/status?token=${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const data = await res.json();
      updateHostIdentity(data.name || data.host || 'Computer');
      updateTransport(data.cableConnected);
      if (data.clipboard) updateRemoteClipboard(data.clipboard);
    } catch (_) {}
  }

  // ---- QR Code Rendering ----
  function renderQr() {
    if (!qrCanvasBox || !window.Qr) return;
    try {
      qrCanvasBox.replaceChildren(window.Qr.canvas(window.location.href, 160));
    } catch (_) {}
  }

  // ---- WebSocket Connection & Handshake ----
  function connectWs() {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnectionState('connected');

      // Handshake: announce device info to host
      ws.send(JSON.stringify({
        t: 'client-info',
        id: clientId,
        name: clientDefaultName,
        os: clientOs,
        kind: clientKind,
        via: isCableConnected ? 'Cable' : 'Wi-Fi',
        ua,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const m = JSON.parse(event.data);
        handleMessage(m);
      } catch (_) {}
    };

    ws.onclose = () => {
      setConnectionState('disconnected');
      wsReconnectTimer = setTimeout(connectWs, 2000);
    };

    ws.onerror = () => {
      setConnectionState('error');
    };
  }

  function setConnectionState(state) {
    const isGood = state === 'connected';
    const cls = isGood ? 'good' : 'warn';
    const label = isGood ? 'Online' : 'Reconnecting…';

    if (sidebarDot) sidebarDot.className = `dot ${cls}`;
    if (mobDot) mobDot.className = `dot ${cls}`;
    if (connStatus) connStatus.textContent = label;
  }

  function handleMessage(m) {
    if (!m || typeof m !== 'object') return;

    if (m.t === 'welcome') {
      if (m.name || m.host) updateHostIdentity(m.name || m.host);
      if (m.clipboard) updateRemoteClipboard(m.clipboard);
      if (m.via) updateTransport(m.via === 'Cable');
    } else if (m.t === 'chat') {
      appendChatMessage(m);
    } else if (m.t === 'clipboard-update') {
      updateRemoteClipboard(m.text);
    } else if (m.t === 'file-offer') {
      appendFileTransfer(m);
    }
  }

  // ---- Device Actions (Ring, Lock, Sleep, Volume) ----
  function sendDevAction(action, value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      t: 'dev-action',
      action,
      value,
    }));
  }

  if (btnHostRing) {
    btnHostRing.addEventListener('click', () => {
      sendDevAction('ring');
      btnHostRing.textContent = 'Ringing…';
      setTimeout(() => { btnHostRing.textContent = 'Ring'; }, 2000);
    });
  }
  if (btnHostLock) {
    btnHostLock.addEventListener('click', () => sendDevAction('lock'));
  }
  if (btnHostSleep) {
    btnHostSleep.addEventListener('click', () => sendDevAction('sleep'));
  }
  if (hostVolumeSlider) {
    hostVolumeSlider.addEventListener('input', (e) => {
      const val = e.target.value;
      if (hostVolumeVal) hostVolumeVal.textContent = `${val}%`;
      sendDevAction('volume', Number(val));
    });
  }
  if (btnHeroDisconnect) {
    btnHeroDisconnect.addEventListener('click', () => {
      if (ws) ws.send(JSON.stringify({ t: 'disconnect' }));
      setConnectionState('disconnected');
    });
  }

  // ---- Two Big Buttons on Files Page ----
  if (btnFilesSendBig && filesFilePicker) {
    btnFilesSendBig.addEventListener('click', () => filesFilePicker.click());
  }
  if (btnFilesReceiveBig) {
    btnFilesReceiveBig.addEventListener('click', () => {
      const firstLink = filesTransfersList.querySelector('.dl-link');
      if (firstLink) firstLink.click();
      else alert('Waiting for files shared from the computer.');
    });
  }

  // File Upload Handlers (for both Drop Zone & Files Page)
  function handleFilesSelected(fileList) {
    if (!fileList || !fileList.length) return;
    Array.from(fileList).forEach((file) => uploadFile(file));
  }

  if (filePicker) {
    filePicker.addEventListener('change', () => {
      handleFilesSelected(filePicker.files);
      filePicker.value = '';
    });
  }
  if (filesFilePicker) {
    filesFilePicker.addEventListener('change', () => {
      handleFilesSelected(filesFilePicker.files);
      filesFilePicker.value = '';
    });
  }
  if (btnAttach && filePicker) {
    btnAttach.addEventListener('click', () => filePicker.click());
  }

  function setupDropTarget(el) {
    if (!el) return;
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files) {
        handleFilesSelected(e.dataTransfer.files);
      }
    });
    el.addEventListener('click', () => {
      if (el === dropZone && filePicker) filePicker.click();
      else if (el === filesDropZone && filesFilePicker) filesFilePicker.click();
    });
  }
  setupDropTarget(dropZone);
  setupDropTarget(filesDropZone);

  function uploadFile(file) {
    if (transferCard) transferCard.style.display = 'block';
    if (transferLabel) transferLabel.textContent = `Sending ${file.name}…`;
    if (transferPct) transferPct.textContent = '0%';
    if (transferFill) transferFill.style.width = '0%';

    const xhr = new XMLHttpRequest();
    const url = `/api/upload?name=${encodeURIComponent(file.name)}&token=${encodeURIComponent(token)}`;
    xhr.open('POST', url, true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        if (transferPct) transferPct.textContent = `${pct}%`;
        if (transferFill) transferFill.style.width = `${pct}%`;
      }
    };

    xhr.onload = () => {
      if (transferCard) {
        setTimeout(() => { transferCard.style.display = 'none'; }, 800);
      }
      appendFileTransfer({
        name: file.name,
        size: file.size,
        direction: 'sent',
      });
    };

    xhr.onerror = () => {
      if (transferLabel) transferLabel.textContent = 'Upload failed';
      setTimeout(() => { if (transferCard) transferCard.style.display = 'none'; }, 2000);
    };

    xhr.send(file);
  }

  function appendFileTransfer(file) {
    if (!filesTransfersList) return;
    const empty = filesTransfersList.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'row';
    const isReceived = !!file.url;

    row.innerHTML = `
      <div class="text">
        <span class="label">${escapeHtml(file.name)}</span>
        <span class="hint">${formatBytes(file.size)} · ${isReceived ? 'Received from PC' : 'Sent to PC'}</span>
      </div>
      <div class="controls">
        ${isReceived ? `<a href="${file.url}?token=${encodeURIComponent(token)}" class="btn small primary dl-link" download="${escapeHtml(file.name)}">Save</a>` : `<span class="pill good">Sent</span>`}
      </div>
    `;
    filesTransfersList.prepend(row);
  }

  // ---- Chat / Drop Stream ----
  function appendChatMessage(m) {
    if (!dropStream) return;
    const isOut = m.from === 'phone';
    const bubble = document.createElement('div');
    bubble.className = `drop-bubble ${isOut ? 'out' : 'in'}`;

    const textEl = document.createElement('div');
    textEl.textContent = m.text;
    bubble.appendChild(textEl);

    const timeEl = document.createElement('div');
    timeEl.className = 'time';
    const d = m.time ? new Date(m.time) : new Date();
    timeEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    bubble.appendChild(timeEl);

    dropStream.appendChild(bubble);
    dropStream.scrollTop = dropStream.scrollHeight;
  }

  function sendDropMessage() {
    if (!dropText) return;
    const text = dropText.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      t: 'chat',
      from: 'phone',
      text,
      toClipboard: sendToClipboard,
    }));

    dropText.value = '';
  }

  if (btnSend) btnSend.addEventListener('click', sendDropMessage);
  if (dropText) {
    dropText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendDropMessage();
    });
  }
  if (btnClipToggle) {
    btnClipToggle.addEventListener('click', () => {
      sendToClipboard = !sendToClipboard;
      btnClipToggle.classList.toggle('active', sendToClipboard);
    });
  }

  // ---- Clipboard Synchronization ----
  function updateRemoteClipboard(text) {
    if (!clipRemoteText) return;
    clipRemoteText.textContent = text || '(Clipboard empty)';
  }

  if (btnCopyRemote) {
    btnCopyRemote.addEventListener('click', async () => {
      const text = clipRemoteText ? clipRemoteText.textContent : '';
      if (!text || text === '(Clipboard empty)') return;
      try {
        await navigator.clipboard.writeText(text);
        const originalText = btnCopyRemote.querySelector('span');
        if (originalText) {
          originalText.textContent = 'Copied';
          setTimeout(() => { originalText.textContent = 'Copy'; }, 1500);
        }
      } catch (_) {}
    });
  }

  if (btnPushLocal) {
    btnPushLocal.addEventListener('click', () => {
      const text = clipLocalInput ? clipLocalInput.value.trim() : '';
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        t: 'clipboard-set',
        text,
      }));
      btnPushLocal.querySelector('span').textContent = 'Pushed';
      setTimeout(() => { btnPushLocal.querySelector('span').textContent = 'Push'; }, 1500);
    });
  }

  // ---- Appearance & Theme Switcher ----
  const segTheme = document.getElementById('seg-theme');
  const accentSwatches = document.getElementById('accent-swatches');

  function applyTheme(theme) {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    localStorage.setItem('td_theme', theme);

    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = isDark ? '#18181a' : '#f2f2f5';

    if (segTheme) {
      segTheme.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.val === theme);
      });
    }
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if ((localStorage.getItem('td_theme') || 'system') === 'system') {
        applyTheme('system');
      }
    });
  }

  function applyAccent(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent-soft', `${color}25`);
    localStorage.setItem('td_accent', color);

    if (accentSwatches) {
      accentSwatches.querySelectorAll('.swatch').forEach((s) => {
        s.classList.toggle('on', s.dataset.color === color);
      });
    }
  }

  if (segTheme) {
    segTheme.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => applyTheme(btn.dataset.val));
    });
  }

  if (accentSwatches) {
    accentSwatches.querySelectorAll('.swatch').forEach((btn) => {
      btn.addEventListener('click', () => applyAccent(btn.dataset.color));
    });
  }

  // Load stored preferences
  const savedTheme = localStorage.getItem('td_theme') || 'system';
  applyTheme(savedTheme);
  const savedAccent = localStorage.getItem('td_accent') || '#0a84ff';
  applyAccent(savedAccent);

  // ---- Helper Utilities ----
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- Startup ----
  fetchStatus();
  renderQr();
  connectWs();
})();
