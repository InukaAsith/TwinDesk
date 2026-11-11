// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck on this computer (Mac, Windows, Linux): a phone or a TwinDesk Web device shows the
// buttons, this computer keeps the layout (settings.deck, shared/deck-model.js) and runs them. Loaded
// only while the Deck module is on (shared/modules.js); nothing else of it runs.
//
// Wire (shared/protocol.js DECK_*), only between this computer and a phone or web device:
//   computer → device  deck.offer {v}: on its welcome. A device without a Deck (an older app, its
//                      Deck module off) says nothing back, and this computer shows no Deck page.
//   device → computer  deck.hello {}: it has a Deck → deck.layout {layout, can: [kinds], mac}
//                      deck.run {page, id}: a button → deck.done {id, ok, why?}
//                      deck.save {layout}: edited on the device → deck.layout to it
//                      deck.apps {}: for its editor → deck.apps {apps: [{id, name, icon}]}
//   computer → device  deck.clip {text}: Clipboard › Send, this computer's clipboard for the device's
//
// new Deck({ server, helper, platform: 'mac'|'win'|'linux', load() → saved layout, save(layout),
//   devLocal() → shared/devlocal.js instance, apps: {list(), open(id)} (shared/deck-apps.js),
//   bright: {can(), step(up)} (shared/deck-apps.js), openUrl(url), readClipboard() → text,
//   onChange(), web: true for TwinDesk Web's bus (its pages ask without an offer) })
// One per session kind (the phones', TwinDesk Web's): a layout saved through one goes to the others'
// devices too. Deck.view() → {surface: names of the devices with a Deck, layout, can}
'use strict';

const P = require('./protocol.js');
const M = require('./deck-model.js');

const T = P.T;
const RUN_GAP_MS = 60; // one button at a time: a burst of taps can't pile up key presses

class Deck {
  constructor(o) {
    Object.assign(this, o);
    this.surface = null; // {name} of the device with a Deck, while one is connected
    this.busy = false;
    Deck.all.add(this);
    const on = (t, fn) => this.server.on(`t:${t}`, (m) => fn(m || {}));
    this.server.on('client', (ctx) => this.offer(ctx));
    this.server.on('closed', () => { this.surface = null; this.onChange(); });
    on(T.DECK_HELLO, () => {
      const c = this.server.current;
      this.surface = { name: (c && c.name) || '' };
      this._layout();
      this.onChange();
    });
    on(T.DECK_RUN, (m) => this.surface && this.run(String(m.page || ''), String(m.id || '')));
    on(T.DECK_SAVE, (m) => this.surface && m.layout && this.setLayout(m.layout));
    on(T.DECK_APPS, () => this.surface && this._apps());
    if (this.server.current) this.offer(this.server.current); // loaded with a device already there
  }

  offer(ctx) {
    if (!this.web && ctx && P.isPhoneOs(ctx.os)) this.server.sendToClient({ t: T.DECK_OFFER, v: 1 }); // a computer has no Deck to show
  }

  get layout() { return M.normalize(this.load ? this.load() : null); }
  get can() {
    const all = ['keys', 'text', 'media', 'url', 'app', 'clip', 'page', 'none'];
    if (this.bright && this.bright.can()) all.push('bright');
    const d = this.devLocal && this.devLocal();
    if (d && d.can && ['lock', 'sleep'].some((x) => (d.can() || {})[x])) all.push('sys');
    return all;
  }
  static view() {
    const all = [...Deck.all];
    if (!all.length) return null;
    return { surface: all.filter((d) => d.surface).map((d) => d.surface.name), layout: all[0].layout, can: all[0].can };
  }

  // From this computer's Deck page or a device's editor.
  setLayout(l) {
    const n = M.normalize(l);
    this.save(n);
    for (const d of Deck.all) d._layout();
    this.onChange();
    return n;
  }

  _layout() {
    if (this.surface) this.server.sendToClient({ t: T.DECK_LAYOUT, layout: this.layout, can: this.can, mac: this.platform === 'mac' });
  }

  async _apps() {
    let apps = [];
    try { apps = await this.apps.list(); } catch (_) { /* none */ }
    this.server.sendToClient({ t: T.DECK_APPS, apps: apps.slice(0, 400) });
  }

  async run(pageId, id) {
    const b = M.find(this.layout, pageId, id);
    const done = (ok, why) => this.server.sendToClient({ t: T.DECK_DONE, id, ok, ...(why ? { why } : {}) });
    if (!b) return done(false, 'This button isn’t on this computer’s Deck any more');
    if (this.busy) return done(false, 'busy');
    this.busy = true;
    try {
      await this.exec(b.action);
      done(true);
    } catch (e) {
      done(false, e.message);
    } finally {
      setTimeout(() => { this.busy = false; }, RUN_GAP_MS);
    }
  }

  // Runs one action here (also from this computer's own Deck page: Try).
  async exec(a) {
    a = M.action(a);
    switch (a.k) {
      case 'keys': return this._press(M.codesOf(a.combo, this.platform === 'mac'));
      case 'media': return this._press([M.MEDIA[a.what]]);
      case 'text': return a.text ? this.helper.send('type', { text: a.text }) : undefined;
      case 'url': if (!a.url) throw new Error('No website set for this button'); return this.openUrl(a.url);
      case 'app': if (!a.id) throw new Error('No app set for this button'); return this.apps.open(a.id);
      case 'bright':
        if (!this.bright || !this.bright.can()) throw new Error('Brightness can’t be changed on this computer');
        return this.bright.step(a.what === 'up');
      case 'sys': {
        const d = this.devLocal && this.devLocal();
        if (!d) throw new Error('Not on this computer');
        return d.do({ do: a.what });
      }
      case 'clip':
        if (a.what === 'send') return this.server.sendToClient({ t: T.DECK_CLIP, text: String(this.readClipboard() || '').slice(0, 100000) });
        return this._press(M.codesOf(`Mod+Key${{ copy: 'C', cut: 'X', paste: 'V' }[a.what]}`, this.platform === 'mac'));
      default: return undefined; // page (the device's), none
    }
  }

  _press(codes) {
    const ev = (t, code) => this.helper.send('inject', { ev: { t, code } });
    for (const c of codes) ev(T.K_KEY_DOWN, c);
    for (const c of codes.slice().reverse()) ev(T.K_KEY_UP, c);
  }

  shutdown() { this.surface = null; Deck.all.delete(this); }
}

Deck.all = new Set();

// The three apps' one call, only while the Deck module is on (main.js): the phones' Deck now, and
// web(bus) for TwinDesk Web's (webwire o.deck). settings.deck holds the layout.
//   o: {platform, helper (or () → helper), server (the phones' session), settings() → settings, saveSettings(),
//       devLocal() → DevLocal, openUrl(url), readClipboard() → text, onChange()}
function startDeck(o) {
  const DA = require('./deck-apps.js');
  const h = typeof o.helper === 'function' ? o.helper : () => o.helper; // Windows and Linux start theirs later
  const helper = {
    send: (...a) => { if (!h()) throw new Error('TwinDesk’s helper isn’t running'); return h().send(...a); },
    request: (...a) => (h() ? h().request(...a) : Promise.reject(new Error('TwinDesk’s helper isn’t running'))),
  };
  const base = {
    helper, platform: o.platform,
    load: () => o.settings().deck,
    save: (l) => { o.settings().deck = l; o.saveSettings(); },
    devLocal: o.devLocal, apps: DA.apps(o.platform, { helper }), bright: DA.bright(o.platform, { helper }),
    openUrl: o.openUrl, readClipboard: o.readClipboard, onChange: o.onChange,
  };
  let phone = null;
  const any = () => phone || [...Deck.all][0] || (phone = new Deck({ ...base, server: new (require('events').EventEmitter)() }));
  const api = {
    // The phones' session: now or once it's there (Windows and Linux make it after TwinDesk Web).
    attach(server) { if (!phone && server) phone = new Deck({ ...base, server }); return api; },
    web: (bus) => new Deck({ ...base, server: bus, web: true }),
    view: () => Deck.view(),
    // This computer's Deck page: save the layout, try a button here.
    save: (l) => any().setLayout(l),
    exec: (a) => any().exec(a),
    apps: () => base.apps.list(),
  };
  return api.attach(o.server);
}

module.exports = { Deck, startDeck };
