// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const api = window.fileShelf;
const list = document.getElementById('items');
let serial = 0;
const bytes = size => size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : size < 1073741824 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1073741824).toFixed(1)} GB`;

function render(state) {
  if (!state) return;
  const focused = document.activeElement?.dataset;
  const wanted = focused?.id, action = focused?.action;
  document.getElementById('title').textContent = state.title;
  document.title = state.title;
  document.getElementById('hint').textContent = state.drag;
  const empty = document.getElementById('empty');
  empty.textContent = state.empty;
  empty.hidden = state.items.length > 0;
  list.replaceChildren(...state.items.map(item => {
    const row = document.createElement('li');
    const file = document.createElement('div');
    file.className = 'item'; file.draggable = true; file.tabIndex = 0;
    file.dataset.id = item.id; file.dataset.action = 'file';
    file.setAttribute('aria-label', item.name);
    const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = item.kind === 'folder' ? '▰' : item.extension || '—';
    const label = document.createElement('div'); label.className = 'label';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = item.name;
    const detail = document.createElement('div'); detail.className = 'detail';
    detail.textContent = [item.kind === 'photo' ? state.photo : item.kind === 'folder' ? state.folder : '', item.size === null ? '' : bytes(item.size)].filter(Boolean).join(' · ');
    label.append(name, detail); file.append(icon, label);
    file.ondragstart = event => { event.preventDefault(); api.drag(item.id); };
    file.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); api.reveal(item.id); } };
    const reveal = document.createElement('button'); reveal.textContent = state.reveal;
    reveal.dataset.id = item.id; reveal.dataset.action = 'reveal'; reveal.onclick = () => api.reveal(item.id);
    row.append(file, reveal);
    return row;
  }));
  if (wanted) [...list.querySelectorAll('[data-id]')].find(element => element.dataset.id === wanted && element.dataset.action === action)?.focus();
}
api.onState(state => { serial++; render(state); });
const initial = serial;
api.read().then(state => { if (serial === initial) render(state); }).catch(() => {});
window.addEventListener('keydown', event => { if (event.key === 'Escape') api.close(); });
