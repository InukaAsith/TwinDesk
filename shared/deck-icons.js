// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's symbols (shared/deck-model.js SYMBOLS) on the computer's Deck page: TwinDesk's own
// line drawings on a 24 × 24 grid, stroked in the tile's text colour. The phone draws the same
// names with its own icons. DeckIcons.svg(name) → an <svg> element; an unknown name is null.
'use strict';

(function (root) {
  const P = {
    play: 'M8 5.5v13l10.5-6.5z',
    pause: 'M8 5.5v13M16 5.5v13',
    next: 'M6 6l8.5 6L6 18zM18 6v12',
    prev: 'M18 6l-8.5 6L18 18zM6 6v12',
    stop: 'M7 7h10v10H7z',
    volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
    volumeDown: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6',
    mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
    mic: 'M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM6 11.5a6 6 0 0 0 12 0M12 17.5v3M9 20.5h6',
    micOff: 'M15 10V6.5a3 3 0 0 0-5.6-1.5M9 9v2.5a3 3 0 0 0 4.7 2.5M6 11.5a6 6 0 0 0 9.6 4.8M18 11.5a6 6 0 0 1-.5 2.3M12 17.5v3M9 20.5h6M4 4l16 16',
    speaker: 'M7 3.5h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1zM12 7.5h.01M12 11a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z',
    headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1zM20 15h-3v5h2a1 1 0 0 0 1-1z',
    bluetooth: 'M7 7.5l10 9-5 4.5v-18l5 4.5-10 9',
    sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
    sunDim: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 5h.01M12 19h.01M5 12h.01M19 12h.01M7 7h.01M17 17h.01M7 17h.01M17 7h.01',
    moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z',
    clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3.5 2',
    cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM9.5 4v3M14.5 4v3M9.5 17v3M14.5 17v3M4 9.5h3M4 14.5h3M17 9.5h3M17 14.5h3',
    memory: 'M3.5 7.5h17v8h-17zM7 10.5v2M10.5 10.5v2M14 10.5v2M17.5 10.5v2M6 15.5v3M18 15.5v3',
    thermo: 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0zM12 9v7.5',
    lock: 'M6.5 10.5h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3',
    sleep: 'M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5zM15 4h4l-4 4h4',
    power: 'M12 3v8M6.8 6.5a7.5 7.5 0 1 0 10.4 0',
    desktop: 'M3.5 4.5h17a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1zM9 20.5h6M12 16.5v4',
    windows: 'M3.5 4.5h7v6h-7zM13.5 4.5h7v6h-7zM3.5 13.5h7v6h-7zM13.5 13.5h7v6h-7z',
    switcher: 'M4 7.5h13M13.5 4l3.5 3.5-3.5 3.5M20 16.5H7M10.5 13L7 16.5l3.5 3.5',
    camera: 'M4 7.5h3l1.5-2.5h7L17 7.5h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1zM12 10a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z',
    crop: 'M6.5 2.5v14a1 1 0 0 0 1 1h14M2.5 6.5h14a1 1 0 0 1 1 1v14',
    keyboard: 'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8',
    command: 'M9 9h6v6H9zM9 9V6.5A2.5 2.5 0 1 0 6.5 9zM15 9V6.5A2.5 2.5 0 1 1 17.5 9zM9 15v2.5A2.5 2.5 0 1 1 6.5 15zM15 15v2.5a2.5 2.5 0 1 0 2.5-2.5z',
    text: 'M5 6.5V5h14v1.5M12 5v14M9.5 19h5',
    macro: 'M4 6.5h9M4 12h9M4 17.5h9M16 5l4 4-4 4',
    globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
    app: 'M5.5 3.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM8.5 12h7M12 8.5v7',
    folder: 'M3.5 6.5a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z',
    terminal: 'M3.5 4.5h17a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM7 9.5l3 2.5-3 2.5M12.5 15h4.5',
    copy: 'M9 8.5h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1zM16 8.5v-3a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3',
    cut: 'M6.5 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM17.5 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8.5 15.5L18 4M15.5 15.5L6 4',
    paste: 'M9 4.5H6.5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-14a1 1 0 0 0-1-1H15M9 3.5h6v3H9zM9 12h6M9 15.5h4',
    send: 'M20.5 3.5l-17 7 7 3 3 7zM10.5 13.5l10-10',
    left: 'M19 12H5M11 6l-6 6 6 6',
    right: 'M5 12h14M13 6l6 6-6 6',
    up: 'M12 19V5M6 11l6-6 6 6',
    down: 'M12 5v14M6 13l6 6 6-6',
    maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    minimize: 'M5 18.5h14',
    display: 'M3.5 4.5h17a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1zM8 20.5h8',
    grid: 'M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z',
    star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
    bolt: 'M13 2.5L5 13.5h6l-1 8 8-11h-6z',
    bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
    bellOff: 'M8.5 5.6A6 6 0 0 1 18 11v4M6 11v5.5l-1.5 2H17M10 20.5a2 2 0 0 0 4 0M4 4l16 16',
    none: 'M6.5 12h11',
  };
  const FILLED = new Set(['play', 'stop']);

  function svg(name, size = 24) {
    const d = P[name];
    if (!d) return null;
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', FILLED.has(name) ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.append(p);
    return s;
  }

  const api = { PATHS: P, svg, has: (n) => !!P[n] };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckIcons = api;
})(typeof window !== 'undefined' ? window : globalThis);
