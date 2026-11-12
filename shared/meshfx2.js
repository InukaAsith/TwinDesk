// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files v2 in Multi-device: one files engine (shared/meshfx2-engine.js, through shared/fx2.js)
// for every session, and per session a view of it that shared/fastfile.js takes as its fx2. A view
// puts its key before every file id it gives the engine and gets back only its own files' events;
// its tokens, reset and cancel are its session's alone. No unencrypted transfers here.
//
//   const m = MeshFx2.make({ tls })   null with TWINDESK_NO_FX2
//   m.listen(tls)                       our server's identity, when the server comes
//   m.port                              the engine's port (0: not up)
//   m.view()                            → a session's fx2 for FastFiles; view.need(on) while it's up
//   m.fx2                               the Fx2 (Engines in use: its state)
'use strict';

const { Fx2, fx2Off } = require('./fx2.js');
const { SEP } = require('./meshfx2-engine.js');

class MeshFx2 {
  static make(opts = {}) {
    return fx2Off() ? null : new MeshFx2(opts);
  }

  constructor({ tls = null, idleMs } = {}) {
    this.fx2 = new Fx2({ tls, idleMs, engine: 'meshfx2-engine.js' });
    this.views = new Map(); // key -> view
    this.tokens = new Map(); // key -> the host session's token
    this.n = 0;
    const route = (id) => {
      const s = String(id);
      const i = s.indexOf(SEP);
      const v = i > 0 ? this.views.get(s.slice(0, i)) : null;
      return v ? [v, s.slice(i + 1)] : [null, s];
    };
    this.fx2.want = (id, size) => { const [v, raw] = route(id); return v && v.want ? v.want(raw, size) : null; };
    this.fx2.doneRecv = (id, hashes) => { const [v, raw] = route(id); if (v && v.doneRecv) v.doneRecv(raw, hashes); };
    this.fx2.failedRecv = (id, early, message) => { const [v, raw] = route(id); if (v && v.failedRecv) v.failedRecv(raw, early, message); };
    this.fx2.bytesRecv = (id, n) => { const [v, raw] = route(id); if (v && v.bytesRecv) v.bytesRecv(raw, n); };
  }

  listen(tls) { this.fx2.listen(tls); }
  get port() { return this.fx2.port; }
  warm() { this.fx2.warm(); }
  whenReady(ms) { return this.fx2.whenReady(ms); }

  _syncTokens() {
    this.fx2.setTokens([...this.tokens].filter(([, t]) => t).map(([k, t]) => `${k}=${t}`));
  }

  view() {
    const key = (++this.n).toString(36);
    const pre = key + SEP;
    const m = this;
    const fx2 = this.fx2;
    const v = {
      key,
      want: null, doneRecv: null, failedRecv: null, bytesRecv: null, // FastFiles sets them
      plainPort: 0,
      get ready() { return fx2.ready; },
      get client() { return fx2.client; },
      get state() { return fx2.state; },
      get crashed() { return fx2.crashed; },
      setPlain() {},
      setTokens(list) {
        const t = (list && list[0]) || '';
        if ((m.tokens.get(key) || '') === t) return;
        if (t) m.tokens.set(key, t); else m.tokens.delete(key);
        m._syncTokens();
      },
      serve: (id, file, size, onBytes) => fx2.serve(pre + id, file, size, onBytes),
      put: (id, file, size, to, onBytes) => fx2.put(pre + id, file, size, to, onBytes),
      pull: (id, file, size, to, onBytes) => fx2.pull(pre + id, file, size, to, onBytes),
      cancel: (id) => fx2.cancel(pre + id),
      // This session's files only (Fx2.reset would stop every session's).
      reset() {
        for (const [k, j] of [...fx2.jobs]) {
          if (!k.slice(k.indexOf(':') + 1).startsWith(pre)) continue;
          fx2.jobs.delete(k);
          j.reject(new Error('the other device disconnected'));
        }
        if (fx2.running) fx2.post({ op: 'resetKey', key });
      },
      need: (on) => fx2.need(`s${key}`, !!on), // the engine stays up while a session is
    };
    this.views.set(key, v);
    return v;
  }
}

module.exports = { MeshFx2 };
