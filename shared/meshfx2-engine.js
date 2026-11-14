// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The files engine for Multi-device: shared/fx2-engine.js as it is, for many sessions at once
// (shared/meshfx2.js starts it in place of that one). The one-to-one engine is left untouched.
//
// Each session has a key, and every file of a session is the engine's `${key}~${id}`. A request to
// our server is taken under the key of the token it carries, so a device reaches only the files of
// its own session (another session's id under its key is just a file nobody serves); our requests
// to another device's engine go out with the plain id. No unencrypted transfers (fxPlain) here.
//
// Messages, as fx2-engine.js's, with these differences:
//   {op:'tokens', list: ['key=token', …]}   each session's key and token (the host's sessions)
//   {op:'resetKey', key}                     one session ended: its files stop (reset stops them all)
//   {op:'plain'}                             ignored
'use strict';

const crypto = require('crypto');
const { Engine, PATH, HEADER } = require('./fx2-engine.js');

const SEP = '~';
const KEY = /^[a-z0-9]{1,12}$/;
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const plainId = (id) => { const s = String(id); const i = s.indexOf(SEP); return i < 0 ? s : s.slice(i + 1); };

class MeshEngine extends Engine {
  constructor(post) {
    super(post);
    this.keyed = []; // [{key, token}]
  }

  handle(m) {
    switch (m && m.op) {
      case 'tokens':
        this.keyed = (Array.isArray(m.list) ? m.list : []).map((e) => {
          const i = String(e).indexOf('=');
          return i > 0 ? { key: String(e).slice(0, i), token: String(e).slice(i + 1) } : null;
        }).filter((e) => e && KEY.test(e.key) && e.token);
        this.tokens = this.keyed.map((e) => e.token);
        this.plainTokens = [];
        return;
      case 'plain': return; // not in Multi-device
      case 'resetKey': {
        const pre = String(m.key) + SEP;
        for (const map of [this.serving, this.outgoing, this.incoming, this.pulls]) for (const id of [...map.keys()]) if (id.startsWith(pre)) this._cancel(id);
        return;
      }
    }
    return super.handle(m);
  }

  // A request under the key of its token: /twindesk/fx2/<id> becomes /twindesk/fx2/<key>~<id>.
  _request(req, res, plain = false) {
    const e = plain ? null : this.keyed.find((x) => same(req.headers[HEADER], x.token));
    if (!e || !req.url.startsWith(PATH)) {
      res.writeHead(plain ? 404 : 403);
      return res.end();
    }
    req.url = PATH + encodeURIComponent(e.key + SEP) + req.url.slice(PATH.length);
    return super._request(req, res, false);
  }

  // To another device's engine: its own id.
  _req(to, method, id, r, size) {
    return super._req(to, method, plainId(id), r, size);
  }
}

// In a utility process (Electron) or a forked child (node), as fx2-engine.js.
if (require.main === module || process.parentPort) {
  const port = process.parentPort;
  if (port) {
    // fx2-engine.js, required above, wired an engine of its own to the parent: only ours answers.
    port.removeAllListeners('message');
    const engine = new MeshEngine((m) => port.postMessage(m));
    port.on('message', (e) => engine.handle(e.data));
  } else if (process.send) {
    const engine = new MeshEngine((m) => process.send(m));
    process.on('message', (m) => engine.handle(m));
    process.on('disconnect', () => process.exit(0));
  }
}

module.exports = { Engine: MeshEngine, SEP };
