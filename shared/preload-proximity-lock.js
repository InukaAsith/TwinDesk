// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const labels = new URLSearchParams(location.search);
  document.documentElement.lang = labels.get('lang');
  document.title = labels.get('title');
  document.getElementById('title').textContent = document.title;
  const remaining = document.getElementById('remaining');
  remaining.textContent = labels.get('remaining');
  const cancel = document.getElementById('cancel');
  cancel.textContent = labels.get('cancel');
  cancel.addEventListener('click', () => ipcRenderer.send('proximity-lock:cancel'));
  ipcRenderer.on('proximity-lock:tick', (_event, text) => { remaining.textContent = text; });
  ipcRenderer.send('proximity-lock:ready');
}, { once: true });
