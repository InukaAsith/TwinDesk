// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// OBS Studio for the Deck's OBS tiles (shared/deck.js): obs-websocket 5, which OBS 28 and later has
// built in (Tools › WebSocket Server Settings), on 127.0.0.1. Only a WebSocket to this computer: no
// process is started and nothing is installed, so nothing here looks like anything to an antivirus.
//
// On demand: connected at a tile's tap or when a device asks for the Deck's state with OBS tiles on
// it, closed IDLE_MS after the last request. No events are subscribed and nothing polls; while
// OBS isn't running a tile says so and nothing tries again by itself.
//
// Config (settings.deckObs, the computer's Deck page): {port, pass}. pass is sealed with
// Electron's safeStorage where there is one (seal/unseal below).
'use strict';

const crypto = require('crypto');
const path = require('path');

const DEFAULT_PORT = 4455;
const IDLE_MS = 30000;
const TIMEOUT_MS = 4000;
const RPC = 1;

let WS = null;
function ws() {
  if (WS) return WS;
  for (const p of ['ws', ...['mac', 'windows', 'linux'].map((d) => path.join(__dirname, '..', d, 'node_modules', 'ws'))]) {
    try { WS = require(p); return WS; } catch (_) {}
  }
  try { WS = require.main.require('ws'); } catch (_) {}
  return WS;
}

// obs-websocket 5's answer to its challenge: base64(sha256(base64(sha256(pass + salt)) + challenge)).
function authOf(pass, salt, challenge) {
  const secret = crypto.createHash('sha256').update(pass + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

// What a tile does, as obs-websocket requests.
const REQ = {
  record: () => ['ToggleRecord'],
  pause: () => ['ToggleRecordPause'],
  stream: () => ['ToggleStream'],
  replay: () => ['SaveReplayBuffer'],
  vcam: () => ['ToggleVirtualCam'],
  scene: (name) => ['SetCurrentProgramScene', { sceneName: name }],
  mute: (name) => ['ToggleInputMute', { inputName: name }],
};
const NEEDS_NAME = ['scene', 'mute'];

// Words people see (shared/i18n.js has them translated).
const WHY = {
  off: 'OBS isn’t running, or its WebSocket server is off (OBS › Tools › WebSocket Server Settings)',
  auth: 'OBS asked for a password: set it on this computer’s Deck page, under OBS Studio',
  name: 'No scene or source set for this tile',
};

class Obs {
  // config() → {port, pass} (pass in the clear); WebSocket: for tests.
  constructor({ config, WebSocket = null } = {}) {
    this.config = config || (() => ({}));
    this.WebSocket = WebSocket;
    this.sock = null;
    this.ready = null; // Promise of an identified socket
    this.pending = new Map();
    this.seq = 0;
    this.idle = null;
  }

  _connect() {
    if (this.ready) return this.ready;
    const W = this.WebSocket || ws();
    if (!W) return Promise.reject(new Error(WHY.off));
    const c = this.config() || {};
    const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : DEFAULT_PORT;
    this.ready = new Promise((resolve, reject) => {
      let s;
      try { s = new W(`ws://127.0.0.1:${port}`, 'obswebsocket.json'); } catch (_) { this.ready = null; return reject(new Error(WHY.off)); }
      this.sock = s;
      let identified = false;
      const fail = (why) => { if (!identified) reject(new Error(why)); };
      const timer = setTimeout(() => { fail(WHY.off); this.close(); }, TIMEOUT_MS);
      s.on('message', (data) => {
        let m;
        try { m = JSON.parse(String(data)); } catch (_) { return; }
        if (m.op === 0) {
          const auth = m.d && m.d.authentication;
          if (auth && !c.pass) { clearTimeout(timer); fail(WHY.auth); return this.close(); }
          const d = { rpcVersion: RPC, eventSubscriptions: 0 };
          if (auth) d.authentication = authOf(String(c.pass), String(auth.salt), String(auth.challenge));
          s.send(JSON.stringify({ op: 1, d }));
        } else if (m.op === 2) {
          identified = true;
          clearTimeout(timer);
          resolve(s);
        } else if (m.op === 7 && m.d) {
          const p = this.pending.get(m.d.requestId);
          if (!p) return;
          this.pending.delete(m.d.requestId);
          const st = m.d.requestStatus || {};
          if (st.result) p.resolve(m.d.responseData || {});
          else p.reject(new Error(st.comment || `OBS said no (${st.code})`));
        }
      });
      s.on('error', () => {});
      s.on('close', (code) => {
        clearTimeout(timer);
        fail(code === 4009 ? WHY.auth : WHY.off);
        if (this.sock === s) { this.sock = null; this.ready = null; }
        for (const p of this.pending.values()) p.reject(new Error(WHY.off));
        this.pending.clear();
      });
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  async request(type, data) {
    const s = await this._connect();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    if (this.idle.unref) this.idle.unref();
    const requestId = String(++this.seq);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error(WHY.off)); }, TIMEOUT_MS);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      s.send(JSON.stringify({ op: 6, d: { requestType: type, requestId, ...(data ? { requestData: data } : {}) } }));
    });
  }

  // A tile: what (REQ's keys) and, for a scene or a source, its name.
  async run(what, name) {
    if (!REQ[what]) throw new Error('Not an OBS action');
    if (NEEDS_NAME.includes(what) && !name) throw new Error(WHY.name);
    const [type, data] = REQ[what](name);
    return this.request(type, data);
  }

  // For the device's tiles and pickers: {on, record, paused, stream, vcam, scene, scenes, inputs}, or
  // {on: false, why} while OBS can't be reached.
  async state() {
    try {
      const [rec, str, scenes, inputs, vcam] = await Promise.all([
        this.request('GetRecordStatus'), this.request('GetStreamStatus'), this.request('GetSceneList'),
        this.request('GetInputList'), this.request('GetVirtualCamStatus').catch(() => ({})),
      ]);
      const names = (list, k) => (Array.isArray(list) ? list.map((x) => x && x[k]).filter((x) => typeof x === 'string').slice(0, 100).map((x) => x.slice(0, 120)) : []);
      return {
        on: true, record: !!rec.outputActive, paused: !!rec.outputPaused, stream: !!str.outputActive, vcam: !!vcam.outputActive,
        scene: typeof scenes.currentProgramSceneName === 'string' ? scenes.currentProgramSceneName.slice(0, 120) : '',
        scenes: names(scenes.scenes, 'sceneName').reverse(), // OBS lists them bottom first
        inputs: names(inputs.inputs, 'inputName'),
      };
    } catch (e) {
      return { on: false, why: (e && e.message) || WHY.off };
    }
  }

  close() {
    clearTimeout(this.idle);
    const s = this.sock;
    this.sock = null;
    this.ready = null;
    if (s) try { s.close(); } catch (_) {}
  }
}

// The password at rest: safeStorage (Keychain, DPAPI, libsecret) where Electron has it, else as is.
function seal(pass) {
  if (!pass) return '';
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(String(pass)).toString('base64');
  } catch (_) {}
  return 'plain:' + String(pass);
}
function unseal(v) {
  if (typeof v !== 'string' || !v) return '';
  if (v.startsWith('plain:')) return v.slice(6);
  if (v.startsWith('enc:')) {
    try { return require('electron').safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch (_) { return ''; }
  }
  return '';
}

module.exports = { Obs, authOf, seal, unseal, REQ, WHY, DEFAULT_PORT };
