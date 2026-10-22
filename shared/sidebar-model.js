// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The main window's left sidebar as data (docs/mesh.md): every device the app knows (computers and
// phones) as a tile, and which sections (Calls, Files, Terminal, ...) belong to which kind of
// device. Pure: the three apps (Windows, Mac, Linux) turn the result into DOM.
// CommonJS in tests, a plain <script> in renderers (window.SidebarModel).
'use strict';

(function (root) {
  // Sections that only make sense for one kind of device. Ids of all three apps (the Mac calls
  // Receive screen 'receive' and Share screen 'share', the PC and Linux 'mac-pc' and 'pc-mac').
  const PHONE_ONLY = ['calls', 'messages', 'media', 'pfiles', 'mount', 'phone'];
  const COMPUTER_ONLY = ['mac-pc', 'receive', 'apps', 'terminal'];
  // Global sections: the same whichever device is selected.
  const GLOBAL = ['overview', 'general', 'about', 'clipboard', 'notifications', 'setup'];
  // Where a device's own sections begin (the first one the app has).
  const FIRST = { phone: ['phone', 'calls'], computer: ['mac-pc', 'receive', 'pc-mac', 'share', 'cursor', 'files'], none: ['overview'] };

  const kindOf = (os) => (os === 'android' ? 'phone' : 'computer');

  // kind: 'phone' | 'computer' | 'none' (no connected selected device: everything but the phone pages).
  function sectionVisible(id, kind) {
    if (kind === 'phone') return !COMPUTER_ONLY.includes(id);
    return !PHONE_ONLY.includes(id);
  }

  // A section that shows the selected device's own settings/data (its header names the device).
  const isScoped = (id) => !GLOBAL.includes(id);

  function firstSection(kind, available) {
    const list = FIRST[kind] || FIRST.none;
    return list.find((id) => available.includes(id)) || (available.includes('overview') ? 'overview' : available[0] || 'overview');
  }

  // Section to show after a device was clicked: the open one when it is device-specific and exists for
  // the kind, else the device's first section.
  function targetSection(current, kind, available) {
    if (current && isScoped(current) && available.includes(current) && sectionVisible(current, kind)) return current;
    return firstSection(kind, available);
  }

  function selectedOf(peers) {
    return (peers || []).find((p) => p && p.selected && p.state !== 'via') || null;
  }

  // 'phone' | 'computer' of the selected connected device, else 'none'.
  function selectedKind(peers) {
    const p = selectedOf(peers);
    return p && p.connected ? kindOf(p.os) : 'none';
  }

  // peers: hub.peers() (id, name, os, state, rtt, selected, connected, via).
  // phones: phones nearby/connected, already prepared by the app: [{id, name, connected, connecting, sub}].
  // transport: how the selected device is reached ('Wi-Fi', 'Bluetooth', ...), shown on its tile.
  // Returns tiles: { id, kind, os, name, state: connected|connecting|nearby|offline|via, connected, selected,
  //   action: 'select'|'connect'|'none', sub, via: [names] }.
  // The same physical device can reach the list under different ids (a beacon, a session and an old
  // pairing, a reinstalled app): name + OS, lower-cased and trimmed, is the fallback key between them.
  const nameKey = (name, os) => String(name || '').normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ').trim() + '|' + (os || '');

  // One tile per physical device: a connected device never also shows as nearby, waiting or via (matched by
  // id first, then by name + OS); the connected entry's data wins. Offline entries are listed once per id and
  // per name + OS (`forget`: every id behind the tile, for the Forget action).
  function buildTiles({ peers = [], phones = [], transport = '' } = {}) {
    const sel = selectedOf(peers);
    const selId = sel ? sel.id : null;
    const phoneT = (d) => {
      const connected = !!d.connected;
      return {
        id: d.id, kind: 'phone', os: 'android', name: d.name || 'Phone', connected, via: [], forget: [],
        state: connected ? 'connected' : d.connecting ? 'connecting' : 'nearby',
        selected: connected && (!selId || selId === d.id),
        action: connected ? 'select' : 'connect',
        sub: d.sub || (connected ? 'Connected' : d.connecting ? 'Connecting…' : 'Nearby · Click to connect'),
      };
    };
    const peerT = (p) => {
      const via = p.state === 'via';
      const connected = !via && !!p.connected;
      const connecting = !via && !connected && (p.state === 'connecting' || p.state === 'reconnecting');
      const selected = connected && !!p.selected;
      let sub;
      if (via) sub = 'via ' + ((p.via || []).join(', ') || 'another device');
      else if (connected) sub = (p.rtt != null ? p.rtt + ' ms' : 'Connected') + (selected && transport && transport !== 'Wi-Fi' ? ' · ' + transport : '');
      else if (connecting) sub = 'Connecting…';
      else if (p.state === 'waiting') sub = 'Waiting for it to connect';
      else if (p.state === 'identity_changed') sub = 'Identity changed';
      else sub = 'Not connected';
      const state = via ? 'via' : connected ? 'connected' : connecting ? 'connecting' : 'offline';
      return {
        id: p.id, kind: kindOf(p.os), os: p.os || 'win', name: p.name || 'Device', connected, selected, via: via ? (p.via || []) : [],
        state, action: connected ? 'select' : 'none', sub, forget: state === 'offline' ? [p.id] : [],
      };
    };
    const all = [
      ...phones.filter((d) => d && d.id).map((d) => [phoneT(d), 0]),
      ...peers.filter((p) => p && p.id).map((p) => [peerT(p), 1]),
    ];
    const ids = new Set();
    const keys = new Set();
    const out = [];
    const take = (t) => { ids.add(t.id); keys.add(nameKey(t.name, t.os)); out.push(t); };
    // 1. connected: by id only (two computers may share a name)
    for (const [t] of all) if (t.connected && !ids.has(t.id)) take(t);
    // 2. nearby / connecting: not already shown (id, then name + OS)
    for (const [t] of all) if (!t.connected && t.state !== 'offline' && t.state !== 'via' && !ids.has(t.id) && !keys.has(nameKey(t.name, t.os))) take(t);
    // 3. offline / waiting: once per id and per name + OS (the ids stay on the tile for Forget)
    const offline = new Map();
    for (const [t] of all) {
      if (t.state !== 'offline' || ids.has(t.id)) continue;
      const k = nameKey(t.name, t.os);
      if (keys.has(k)) continue;
      if (offline.has(k)) { const f = offline.get(k); if (!f.forget.includes(t.id)) f.forget.push(t.id); continue; }
      offline.set(k, t);
      out.push(t);
    }
    for (const t of offline.values()) { ids.add(t.id); keys.add(nameKey(t.name, t.os)); }
    // 4. known only through another device
    for (const [t] of all) if (t.state === 'via' && !ids.has(t.id) && !keys.has(nameKey(t.name, t.os))) take(t);
    // Connected first, then nearby/connecting, offline, and last those only another device reaches; otherwise as given.
    const rank = (t) => (t.connected ? 0 : t.state === 'via' ? 3 : t.state === 'offline' ? 2 : 1);
    return out.map((t, i) => [t, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map((x) => x[0]);
  }

  // Linux has no hub: its one peer (the app's `peer` {id, name, os} and link state) as a peers list.
  function singlePeer(peer, linkState, rtt) {
    if (!peer || !peer.id) return [];
    const connected = linkState === 'connected';
    return [{ id: peer.id, name: peer.name, os: peer.os, state: connected ? 'connected' : linkState || 'offline', rtt: connected && rtt != null ? rtt : null, selected: true, connected, via: [] }];
  }

  const api = { PHONE_ONLY, COMPUTER_ONLY, GLOBAL, kindOf, sectionVisible, isScoped, firstSection, targetSection, selectedOf, selectedKind, buildTiles, singlePeer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SidebarModel = api;
})(typeof self !== 'undefined' ? self : this);
