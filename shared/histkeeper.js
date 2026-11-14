// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// History › Keep history (the Clipboard and Notifications pages, Mac, Windows and Linux): the
// clipboard's Recent items and the phone's notifications kept across restarts, encrypted
// (shared/histkeep.js), for as long as chosen. Off at first.
//
// It sits beside each app's own clipboard (its history and _remember) and notifications (its
// history list): new items are sealed as they come, which needs no keychain; the kept ones come
// back only when a history is looked at (unlock, from the page), the one time the system's safe
// storage is read — so TwinDesk never asks for the keychain when it opens.
//
// new HistoryKeeper({dir, clip, notifs, changed}) · view() · act({do: 'set', save, days} |
// {do: 'unlock', what: 'clip'|'notifs'} | {do: 'clear'})
'use strict';

const fs = require('fs');
const path = require('path');
const { HistKeep, merge, safeWrap, DAYS } = require('./histkeep.js');

const pickClip = (h) => (h && !h.image && typeof h.text === 'string' ? { dir: h.dir, at: h.at, text: h.text.slice(0, 20000), size: h.size } : null);
const pickNotif = (n) => (n && n.at ? { id: n.id, app: n.app, appName: n.appName, title: n.title, subtitle: n.subtitle, body: n.body, at: n.at } : null);

class HistoryKeeper {
  constructor({ dir, clip, notifs, changed = () => {}, wrap = null }) {
    this.cfgFile = path.join(dir, 'history.json');
    this.changed = changed;
    this.cfg = { save: false, days: 7 };
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(this.cfgFile, 'utf8'))); } catch (_) { /* first time */ }
    const w = wrap || safeWrap();
    this.parts = {};
    if (clip) this.parts.clip = { obj: clip, keep: new HistKeep({ dir, name: 'clipboard', wrap: w }), pick: pickClip, cap: () => Number((clip.cfg && clip.cfg.historySize) || 20), open: false };
    if (notifs) this.parts.notifs = { obj: notifs, keep: new HistKeep({ dir, name: 'notifications', wrap: w }), pick: pickNotif, cap: () => 50, open: false };
    this.error = '';
    for (const p of Object.values(this.parts)) {
      p.keep.setOn(!!this.cfg.save, this.cfg.days);
      p.keep.prune();
    }
    if (clip) this._hookClip(this.parts.clip);
    if (notifs) this._hookNotifs(this.parts.notifs);
  }

  // The clipboard: each item as _remember adds it; Clear clears what's kept too.
  _hookClip(p) {
    const o = p.obj;
    if (typeof o._remember === 'function') {
      const orig = o._remember.bind(o);
      o._remember = (...args) => { // (dir, item), or (dir, text, from) in Multi-device
        const r = orig(...args);
        const h = o.history && o.history[0];
        const x = this.cfg.save && p.pick(h);
        if (x) p.keep.add([x]);
        return r;
      };
    }
    this._hookClear(p);
  }

  // Notifications: their list is replaced as each one comes, so its setter sees the new ones.
  _hookNotifs(p) {
    const o = p.obj;
    let list = o.history || [];
    const seen = new Set(list.map((n) => n.id));
    Object.defineProperty(o, 'history', {
      configurable: true, enumerable: true,
      get: () => list,
      set: (v) => {
        list = Array.isArray(v) ? v : [];
        const fresh = list.filter((n) => n && n.id && !seen.has(n.id));
        for (const n of fresh) seen.add(n.id);
        if (seen.size > 5000) { seen.clear(); for (const n of list) seen.add(n.id); }
        if (this.cfg.save && fresh.length) p.keep.add(fresh.map(p.pick).filter(Boolean));
      },
    });
    this._hookClear(p);
  }

  _hookClear(p) {
    const o = p.obj;
    if (typeof o.clearHistory !== 'function') return;
    const orig = o.clearHistory.bind(o);
    o.clearHistory = (...a) => { p.keep.clear(); return orig(...a); };
  }

  _save() {
    try { fs.writeFileSync(this.cfgFile, JSON.stringify(this.cfg)); } catch (_) { /* this session */ }
  }

  // The kept items back into the page's list (once a session for each), newest first.
  unlock(what) {
    const p = this.parts[what];
    if (!p || !this.cfg.save || p.open) return;
    try {
      const kept = p.keep.unlock();
      p.open = true;
      this.error = '';
      const cur = p.obj.history || [];
      const all = merge(cur, kept, p.cap() || 1);
      if (what === 'clip') { p.obj.history.length = 0; p.obj.history.push(...all); } else p.obj.history = all;
    } catch (e) {
      this.error = 'The saved history couldn’t be opened: ' + (e && e.message ? e.message : 'the key wasn’t given');
    }
    this.changed();
  }

  act(r = {}) {
    if (r.do === 'set') {
      if (r.save !== undefined) this.cfg.save = r.save === true;
      if (r.days !== undefined && DAYS.includes(Number(r.days))) this.cfg.days = Number(r.days);
      this._save();
      for (const [what, p] of Object.entries(this.parts)) {
        try { p.keep.setOn(this.cfg.save, this.cfg.days); } catch (e) { this.error = 'History can’t be kept: ' + e.message; this.cfg.save = false; this._save(); }
        if (this.cfg.save) {
          // What's in the lists now is kept from here on.
          const now = (p.obj.history || []).map(p.pick).filter(Boolean);
          if (now.length && !p.open) p.keep.add(now);
          p.open = p.open && this.cfg.save;
          p.keep.prune();
        } else p.open = false;
        void what;
      }
    } else if (r.do === 'unlock') this.unlock(r.what === 'notifs' ? 'notifs' : 'clip');
    else if (r.do === 'clear') for (const p of Object.values(this.parts)) p.keep.clear();
    this.changed();
    return this.view();
  }

  view() {
    return { save: !!this.cfg.save, days: this.cfg.days, error: this.error, open: Object.fromEntries(Object.entries(this.parts).map(([k, p]) => [k, p.open])) };
  }
}

module.exports = { HistoryKeeper };
