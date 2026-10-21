// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Calls, Messages, Photos and Files from a phone, for the Mac, PC and Linux apps alike (Hub.kt on
// the phone). Required by main.js only once a phone connects or one of them is switched on, so a
// computer that never uses them never loads this. While each is off nothing of it runs here or on
// the phone; the phone only hears which are on (hub.policy) as a session starts.
//
// server: the phone-facing session (mac/peer.js, or phone-link.js): on('client'|'closed'),
// on('t:<type>'), sendToClient(), current. audio: () => this computer's call sound over Bluetooth
// (callaudio.js), made only while Calls and its Bluetooth option are on with a phone connected.
// btSettings(): opens this computer's Bluetooth settings, where the phone is paired for that.
// send(paths, batch): files to the phone (the file sender's sendBatch); choose(): files picked here.
// share: shared folders' options (foldershare.js), when this computer has them.
//
// Events: 'change' (view), 'data' (a reply for the window: forwarded as is), 'call' (call, before).
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./protocol.js');

const T = P.T;
const WHAT = ['calls', 'messages', 'media', 'files'];
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const picture = (v, max) => (typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= max ? v : '');

// What the pages may ask the phone for, and which switch it needs.
const ASKS = {
  [T.CALL_DO]: 'calls', [T.CALL_LOG]: 'calls', [T.CONTACTS]: 'calls',
  [T.SMS_THREADS]: 'messages', [T.SMS_THREAD]: 'messages', [T.SMS_PART]: 'messages', [T.SMS_SEND]: 'messages',
  [T.MEDIA_LIST]: 'media', [T.MEDIA_THUMB]: 'media', [T.MEDIA_VIEW]: 'media', [T.MEDIA_SAVE]: 'media',
  [T.FS_LIST]: 'files', [T.FS_DO]: 'files', [T.FS_SAVE]: 'files',
};
// The phone's answers, passed to the window.
const ANSWERS = {
  [T.CALL_DONE]: 'calls', [T.CALL_LOG]: 'calls', [T.CONTACTS]: 'calls',
  [T.SMS_THREADS]: 'messages', [T.SMS_THREAD]: 'messages', [T.SMS_PART]: 'messages', [T.SMS_SENT]: 'messages', [T.SMS_NEW]: 'messages',
  [T.MEDIA_LIST]: 'media', [T.MEDIA_THUMB]: 'media', [T.MEDIA_VIEW]: 'media',
  [T.FS_LIST]: 'files', [T.FS_DONE]: 'files',
};
// A path on the phone, relative to its shared storage: no '..', no empty or odd segments.
const phonePath = (v) => {
  if (typeof v !== 'string' || v.length > 1000) return null;
  const parts = v.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || /[\u0000-\u001f]/.test(p))) return null;
  return parts.join('/');
};
const fileName = (v) => (typeof v === 'string' && v.trim() && v.length <= 255 && !/[/\u0000-\u001f]/.test(v) && v.trim() !== '.' && v.trim() !== '..' ? v.trim() : '');
const PAIR_WATCH_MS = 5 * 60000; // looking for the phone's pairing this long after setup or Forget
const PAIR_POLL_MS = 3000;

class PhoneHub extends EventEmitter {
  // audioLimit: what this computer can't do with the calls' sound, said under its switch (Windows).
  constructor({ server, getSettings, save, audio, audioLimit, btSettings, send, choose, share }) {
    super();
    Object.assign(this, { server, getSettings, save, makeAudio: audio || null, audioLimit: audioLimit || '', btSettings: btSettings || null, sendFiles: send || null, choose: choose || null });
    this.pairTimer = null; // looking for the phone's pairing (watchPair)
    this.share = null;
    if (share) {
      this.share = new (require('./foldershare.js').FolderShare)(this, share);
      this.share.on('change', () => this.emit('change'));
    }
    this.state = null; // hub.state: the phone's permissions (null: no phone, or one too old to know these)
    this.call = null; // {state: 'ringing'|'offhook', number, name, photo, dir, since}
    this.ended = null; // the call that just ended {..., missed, at}
    this.unread = 0; // texts that came in since the Messages page was last looked at
    this.audio = null;
    this.muted = false;

    server.on('client', (ctx) => isPhone(ctx) && this.started());
    server.on('closed', (ctx) => isPhone(ctx) && this.stopped());
    const on = (t, fn) => server.on(`t:${t}`, (m, ctx) => isPhone(ctx) && fn(m));
    on(T.HUB_STATE, (m) => {
      const perm = (x) => (x && ['ok', 'partial', 'ask', 'none'].includes(x.perm) ? x.perm : 'ask');
      const missing = (x) => (x && Array.isArray(x.missing) ? x.missing.filter((s) => typeof s === 'string').slice(0, 8) : []);
      const bt = m.bt && typeof m.bt === 'object' ? m.bt : {};
      // The phone couldn't drop its old pairing and asks its person to forget this computer: this
      // computer forgets the phone too, or it keeps keys the phone no longer has and TwinDesk's own
      // Bluetooth LE link to it fails on them.
      if (bt.forget && !(this.state && this.state.bt.forget) && this.audio && this.audio.unpair) this.audio.unpair();
      this.state = {
        calls: { perm: perm(m.calls), missing: missing(m.calls) },
        messages: { perm: perm(m.messages), missing: missing(m.messages) },
        media: { perm: perm(m.media) },
        files: { perm: perm(m.files) },
        bt: {
          allowed: bt.allowed !== false, radio: bt.radio !== false, name: str(bt.name, 100), bonded: bt.bonded === true ? true : bt.bonded === false ? false : null,
          le: !!bt.le, bonding: !!bt.bonding, forget: !!bt.forget, // le: paired over Bluetooth LE only (no calls' sound through it)
        },
        opens: !!m.opens,
      };
      if (this.audio) this.audio.phone(this.state.bt.name);
      this.emit('change');
    });
    // Switched on or off on the phone: this computer keeps the setting.
    on(T.HUB_SET, (m) => {
      if (!WHAT.includes(m.what)) return;
      this.settings[m.what] = !!m.on;
      this.save();
      this.applyAudio();
      this.emit('change');
    });
    // Forget on the phone: it forgot this computer, and this computer forgets it too.
    on(T.HUB_BT, (m) => m.unpair && this.forget(true));
    on(T.CALL_STATE, (m) => this.onCall(m));
    on(T.SHARE_OFFER, (m) => { if (this.share) { this.share.onOffer(m); this.share.host(); } });
    on(T.SHARE_SET, (m) => this.share && this.share.act('serve', { on: !!m.serve })); // switched on the phone
    for (const t of Object.keys(ANSWERS)) on(t, (m) => this.onAnswer(m));
  }

  get settings() {
    return this.getSettings().hub;
  }

  get phone() {
    const c = this.server.current;
    return isPhone(c) ? c : null;
  }

  // A phone's session started (or this was loaded while one is connected).
  started() {
    this.state = null;
    this.call = null;
    this.unread = 0;
    this.policy();
    this.applyAudio();
    if (this.share) this.share.started();
    this.emit('change');
  }

  stopped() {
    if (this.share) this.share.stopped();
    const had = this.call;
    this.state = null;
    this.call = null;
    this.applyAudio();
    if (had) this.emit('call', null, had);
    this.emit('change');
  }

  policy() {
    const s = this.settings;
    this.server.sendToClient({ t: T.HUB_POLICY, calls: !!s.calls, messages: !!s.messages, media: !!s.media, files: !!s.files, bt: !!(this.makeAudio && s.calls && s.callAudio) }); // bt: be this computer's hands-free (none on a Mac)
  }

  // ---- from the window ----

  // {do: 'set', what, on} | {do: 'opt', callAudio?, btDevice?} | {do: 'ask', what} | {do: 'seen'}
  // | {do: 'send', msg} | {do: 'audio', a: 'here'|'phone'|'connect'|'check'|'settings'|'forget'} | {do: 'call', a, number?, on?}
  // | {do: 'upload', path, paths? (none: chosen here first)} | {do: 'share', a: 'mount'|'unmount'|'auto'|'serve'|'choose'|'default', on?}
  act(r) {
    if (!r || typeof r !== 'object') return;
    const s = this.settings;
    switch (r.do) {
      case 'set':
        if (!WHAT.includes(r.what)) return;
        s[r.what] = !!r.on;
        this.save();
        if (this.phone) this.policy();
        this.applyAudio();
        return this.emit('change');
      case 'opt':
        if (typeof r.callAudio === 'boolean') s.callAudio = r.callAudio;
        if (typeof r.btDevice === 'string') this.btDevice(r.btDevice.slice(0, 400)); // Windows' device ids are long
        this.save();
        if (this.phone) this.policy();
        if (typeof r.btDevice === 'string' && this.audio) { this.audio.stop(); this.audio = null; }
        this.applyAudio();
        return this.emit('change');
      case 'ask':
        if (WHAT.includes(r.what) || r.what === 'bt') this.server.sendToClient({ t: T.HUB_ASK, what: r.what });
        return;
      case 'upload':
        return this.upload(r.path, r.paths);
      case 'seen':
        if (!this.unread) return;
        this.unread = 0;
        return this.emit('change');
      case 'send':
        return this.ask(r.msg);
      case 'audio':
        return this.audioAct(String(r.a || ''));
      case 'call':
        return this.callAct(String(r.a || ''), r);
      case 'share':
        return this.share && this.share.act(String(r.a || ''), r);
      default:
    }
  }

  // What a page asks the phone for: only the fields each takes, only while that one is on.
  ask(m) {
    if (!m || typeof m !== 'object' || !ASKS[m.t] || !this.settings[ASKS[m.t]] || !this.phone) return;
    const n = (v, max, d) => Math.max(1, Math.min(max, Number.isInteger(v) ? v : d));
    const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[a-z]?\d{1,18}$/.test(x)).slice(0, 300) : []);
    const out = { t: m.t };
    switch (m.t) {
      case T.CALL_DO: return this.callAct(str(m.a, 20), m);
      case T.CALL_LOG: out.n = n(m.n, 300, 100); break;
      case T.CONTACTS: out.q = str(m.q, 80); break;
      case T.SMS_THREADS: out.n = n(m.n, 300, 60); break;
      case T.SMS_THREAD: Object.assign(out, { id: str(m.id, 20), before: Number(m.before) || 0, n: n(m.n, 200, 50) }); break;
      case T.SMS_PART: out.id = str(m.id, 40); break;
      case T.SMS_SEND: Object.assign(out, { to: str(m.to, 60), body: str(m.body, 5000), ref: str(m.ref, 60) }); break;
      case T.MEDIA_LIST: Object.assign(out, { kind: ['all', 'photos', 'videos', 'screenshots'].includes(m.kind) ? m.kind : 'all', before: str(m.before, 40), n: n(m.n, 500, 120) }); break;
      case T.MEDIA_THUMB: out.ids = ids(m.ids); break;
      case T.MEDIA_VIEW: out.id = str(m.id, 40); break;
      case T.MEDIA_SAVE: out.ids = ids(m.ids); break;
      case T.FS_LIST: {
        const p = phonePath(m.path);
        if (p == null) return;
        Object.assign(out, { path: p, hidden: !!m.hidden });
        break;
      }
      case T.FS_DO: {
        const p = phonePath(m.path);
        const a = ['mkdir', 'rename', 'delete'].includes(m.a) ? m.a : '';
        if (p == null || !a) return;
        Object.assign(out, { a, path: p, ref: str(m.ref, 60) });
        if (a !== 'delete' && !(out.name = fileName(m.name))) return;
        if (a === 'delete') {
          out.paths = (Array.isArray(m.paths) ? m.paths : []).map(phonePath).filter((x) => x).slice(0, 500);
          if (!out.paths.length) return;
        }
        break;
      }
      case T.FS_SAVE:
        out.paths = (Array.isArray(m.paths) ? m.paths : []).map(phonePath).filter((x) => x).slice(0, 500);
        if (!out.paths.length) return;
        break;
      default: return;
    }
    this.server.sendToClient(out);
  }

  // Files from here into a folder on the phone: it's told where this batch goes, then the batch
  // goes as Send does (a direct Wi-Fi link through Bluetooth, as for any files).
  async upload(dir, paths) {
    const p = phonePath(dir);
    if (p == null || !this.settings.files || !this.phone || !this.sendFiles) return;
    if (!Array.isArray(paths)) paths = this.choose ? await this.choose() : [];
    paths = (paths || []).filter((x) => typeof x === 'string' && x).slice(0, 1000);
    if (!paths.length || !this.phone) return;
    const batch = crypto.randomUUID();
    this.server.sendToClient({ t: T.FS_EXPECT, batch, path: p });
    if (!this.sendFiles(paths, batch)) this.emit('data', { t: T.FS_DONE, ok: false, error: 'Nothing to send', path: p });
  }

  // Answer, Decline, End, Call, Mute (the popup, the Calls page). Over Bluetooth the microphone
  // muted is this computer's; otherwise the phone's.
  callAct(a, m = {}) {
    if (!this.settings.calls || !this.phone) return;
    if (a === 'mute') {
      this.muted = !!m.on;
      if (this.audio && this.audio.view.state === 'ready' && this.audio.view.canMute !== false) this.audio.mute(this.muted);
      else this.server.sendToClient({ t: T.CALL_DO, a: 'mute', on: this.muted });
      return this.emit('change');
    }
    if (a === 'dial') {
      const number = str(m.number, 60).replace(/[^\d+*#,;]/g, '');
      if (number) this.server.sendToClient({ t: T.CALL_DO, a, number });
      return;
    }
    if (a === 'answer' || a === 'end') this.server.sendToClient({ t: T.CALL_DO, a });
  }

  // ---- from the phone ----

  onCall(m) {
    if (!this.settings.calls) return;
    const was = this.call;
    const st = m.state === 'ringing' || m.state === 'offhook' ? m.state : 'idle';
    if (st === 'idle') {
      this.call = null;
      this.muted = false;
      if (was && this.audio) this.audio.idle(); // the microphone as it was, the next call here again
      if (was) this.ended = { ...was, missed: was.state === 'ringing' && was.dir === 'in', at: Date.now() };
    } else {
      const same = was && was.state === st;
      this.call = {
        state: st,
        number: str(m.number, 40) || (was ? was.number : ''),
        name: str(m.name, 100) || (was ? was.name : ''),
        photo: picture(m.photo, 60000) || (was ? was.photo : ''),
        dir: m.dir === 'out' ? 'out' : 'in',
        since: same ? was.since : Date.now(), // this computer's clock: the timer counts from here
      };
    }
    // A call under way with the hands-free link up: its sound comes here (the phone may keep it
    // on itself when the call started there), unless it was sent to the phone during this call.
    if (st === 'offhook' && (!was || was.state !== 'offhook')) {
      this.pulled = false;
      setTimeout(() => {
        const v = this.audio && this.audio.view;
        if (!this.call || this.call.state !== 'offhook' || this.pulled || !v || v.state !== 'ready' || v.here || v.canMove === false) return;
        this.pulled = true;
        this.audio.transfer(true);
      }, 1200);
    }
    this.emit('call', this.call, was);
    this.emit('change');
  }

  onAnswer(m) {
    if (!this.settings[ANSWERS[m.t]]) return;
    if ('data' in m) m = { ...m, data: picture(m.data, 12e6) }; // pictures only (thumbnails, previews, MMS)
    if (m.t === T.SMS_NEW && m.msg && !m.msg.out) {
      this.unread++;
      this.emit('change');
    }
    this.emit('data', m);
  }

  // ---- call sound over Bluetooth ----

  // The Bluetooth device the connected phone is (each phone its own: one paired before isn't this one), or set it.
  btDevice(id) {
    const s = this.settings;
    const phone = this.phone && this.phone.deviceId;
    if (id === undefined) return (phone && s.btDevices && s.btDevices[phone]) || '';
    if (!phone) return;
    s.btDevices = { ...(s.btDevices || {}), [phone]: id };
    this.save();
  }

  // Running only while Calls and its Bluetooth option are on, with a phone connected.
  applyAudio() {
    const s = this.settings;
    const want = !!(this.makeAudio && s.calls && s.callAudio && this.phone);
    if (!want) {
      this.unwatchPair();
      if (this.audio) {
        this.audio.stop();
        this.audio = null;
        this.emit('change');
      }
      return;
    }
    if (this.audio) return;
    try {
      this.audio = this.makeAudio({ device: () => this.btDevice(), save: (id) => this.btDevice(id) });
    } catch (e) {
      console.log(`[hub] call sound: ${e.message}`);
      this.audio = null;
      return;
    }
    if (!this.audio) return;
    this.audio.on('change', () => this.emit('change'));
    this.audio.on('address', (address) => this.phone && this.server.sendToClient({ t: T.HUB_BT, address }));
    this.audio.start(this.state ? this.state.bt.name : '');
  }

  audioAct(a) {
    if (!this.audio) return;
    if (a === 'here' || a === 'phone') { this.pulled = true; this.audio.transfer(a === 'here'); }
    else if (a === 'connect') this.audio.start(this.state ? this.state.bt.name : '');
    else if (a === 'check') { if (this.audio.check) this.audio.check(); } // back in the window: paired meanwhile?
    else if (a === 'settings') this.pairHere();
    else if (a === 'forget') this.forget(false);
  }

  // This computer's Bluetooth settings, where the person pairs the phone over classic Bluetooth (the
  // kind a call goes through; TwinDesk doesn't pair them itself); the phone is looked for until it's there.
  pairHere() {
    if (this.btSettings) this.btSettings();
    this.watchPair();
  }

  // Forget: both forget each other, over classic Bluetooth and LE, so neither keeps keys the other
  // dropped (TwinDesk's own LE link fails on those), and this computer's Bluetooth settings open to
  // pair them again. The phone hears first: over Bluetooth LE the session may go with the pairing.
  forget(fromPhone) {
    if (!this.audio) return;
    if (!fromPhone && this.phone) this.server.sendToClient({ t: T.HUB_BT, address: this.audio.view.address || '', unpair: true });
    if (this.audio.unpair) this.audio.unpair();
    this.pairHere();
  }

  // Back from pairing: the phone looked for every few seconds for a while, and connected to as soon
  // as it's there (callaudio's check() only looks while it isn't).
  watchPair() {
    clearInterval(this.pairTimer);
    const until = Date.now() + PAIR_WATCH_MS;
    this.pairTimer = setInterval(() => {
      const st = this.audio && this.audio.view.state;
      if (!st || ['ready', 'connecting', 'off'].includes(st) || Date.now() > until) return this.unwatchPair();
      if (this.audio.check) this.audio.check();
    }, PAIR_POLL_MS);
    this.emit('change');
  }

  unwatchPair() {
    if (!this.pairTimer) return;
    clearInterval(this.pairTimer);
    this.pairTimer = null;
    this.emit('change');
  }

  get view() {
    const s = this.settings;
    return {
      calls: !!s.calls, messages: !!s.messages, media: !!s.media, files: !!s.files, callAudio: !!s.callAudio, btDevice: this.btDevice(),
      connected: !!this.phone, name: this.phone ? this.phone.name : '',
      supported: !!this.state, // the phone app answered (an older one doesn't know these)
      perm: this.state, call: this.call, ended: this.ended, unread: this.unread, muted: this.muted,
      audio: this.audio ? this.audio.view : null, canAudio: !!this.makeAudio, audioLimit: this.audioLimit,
      btSettings: !!this.btSettings, pairWatch: !!this.pairTimer, // pairing for the calls' sound: Open Bluetooth settings, looking for the phone
      share: this.share ? this.share.view : null,
    };
  }
}

module.exports = { PhoneHub };
