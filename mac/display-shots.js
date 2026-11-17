// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Session-memory pictures of the desktops the catalog already allows.
//
// Each shot is one helper displayShot of one display id, and only while the viewer
// who is allowed to see that catalog still has its Displays & desktops sheet open on
// this exact socket. The helper uses ScreenCaptureKit on macOS 14 and refuses
// everywhere else. This file does not ask Electron for a thumbnail.
// Before the request and after it returns, the same authenticated socket, capture
// session, view generation, current space, unlocked screen, and a fresh accessibility
// read of a hidden Mission Control must still hold. Closing the sheet, leaving the
// foreground, stop, lock, revoked input, disconnect, or a replacement socket cancels
// the ask and drops an in-flight reply. Stop, lock, revoked input, disconnect, and
// replacement also drop the stored bytes. The cache is not written to disk.
// Every reply carries the sheet-open epoch from screen.preview.want. A new open on
// the same socket is a new epoch: the in-flight shot is dropped and stored pictures
// stay. A reply is not sent without that epoch.
'use strict';

const P = require('../shared/protocol.js');
const Preview = require('../shared/display-preview.js');

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (timer.unref) timer.unref();
  return timer;
}

class DisplayShots {
  constructor({ helper, readLocked, freshLook, sample, send, wait, schedule, clearTimer, now }) {
    this.helper = helper;
    this.readLocked = readLocked;
    this.freshLook = freshLook;
    this.sample = sample;
    this.send = send;
    this.wait = wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.schedule = schedule || defaultSchedule;
    this.clearTimer = clearTimer || ((timer) => clearTimeout(timer));
    this.now = now || (() => Date.now());
    this.bags = new Map();
    this.ticket = 0;
    this.epoch = 0;
    this.ask = null;
    this.watched = null;
    this.lastWatch = null;
    this.running = false;
    this.again = false;
    this.pending = Promise.resolve();
    this.timer = null;
    this.lastAt = 0;
  }

  // The sheet is open on this socket for this epoch. A different socket is a
  // replacement: the old session's pictures are not forwarded, and the in-flight
  // shot is dropped. The same socket with a new epoch is the next sheet-open:
  // drop the in-flight shot, keep the stored pictures, and answer with the new epoch.
  // An epoch that is not a positive safe integer does not start a capture.
  watch(conn, epoch) {
    const ask = Preview.askEpoch(epoch);
    if (ask == null) return this.pending;
    if (!Preview.liveConn(conn)) return this.cancel('session');
    const ws = conn.ws;
    const watched = this.watched;
    if (watched && watched.conn === conn && watched.ws === ws && watched.epoch === ask) {
      this.kick();
      return this.pending;
    }
    const last = this.lastWatch;
    if (last && last.conn === conn && last.ws === ws && ask <= last.epoch) return this.pending;
    if (watched && (watched.conn !== conn || watched.ws !== ws)) this.cancel('session');
    else if (watched) this.cancel('close');
    this.ask = ask;
    this.watched = { conn, ws, epoch: ask };
    this.lastWatch = { conn, ws, epoch: ask };
    this.kick();
    return this.pending;
  }

  // close: the sheet or the foreground went away. The last-seen pictures stay.
  // session: stop, lock, revoked input, disconnect, or a replacement socket.
  // A session end still drops stored pictures when the sheet already closed, so a
  // lock that arrives after that close cannot leave them for the next ask.
  cancel(why) {
    const watch = this.watched;
    const session = why === 'session';
    if (!watch && !session) return this.pending;
    if (!watch && session && !this._stored()) {
      this.ask = null;
      return this.pending;
    }
    const ask = this.ask;
    this._fence();
    this.watched = null;
    // A closed sheet keeps the epoch. A later session clear still names that open.
    if (!session) return this.pending;
    for (const [conn, bag] of this.bags) this._clear({ conn, ws: conn ? conn.ws : null }, bag, ask);
    this.ask = null;
    return this.pending;
  }

  kick() {
    if (this.running) {
      this.again = true;
      return this.pending;
    }
    this.pending = this._run();
    return this.pending;
  }

  _sample() {
    try {
      const value = this.sample();
      if (!value || typeof value !== 'object') return null;
      // Copy the fence. The caller's object stays live, so a later read has to see a new
      // socket or capture session instead of the one this pass started with.
      return {
        conn: value.conn,
        ws: value.conn ? value.conn.ws : null,
        sharing: value.sharing === true,
        input: value.input !== false,
        catalog: value.catalog,
        capture: value.capture,
        viewGen: value.viewGen,
      };
    } catch (_) {
      return null;
    }
  }

  _bag(conn) {
    let bag = this.bags.get(conn);
    if (!bag) {
      bag = { shots: new Map(), bytes: 0, sent: false, notice: '', noticeAt: 0 };
      this.bags.set(conn, bag);
      this._capBags(conn);
    }
    return bag;
  }

  _capBags(keep) {
    while (this.bags.size > Preview.MAX_BAGS) {
      let drop = null;
      for (const conn of this.bags.keys()) {
        if (conn !== keep) { drop = conn; break; }
      }
      if (!drop) break;
      this.bags.delete(drop);
    }
  }

  _prune() {
    for (const conn of this.bags.keys()) {
      if (!Preview.liveConn(conn)) this.bags.delete(conn);
    }
  }

  _watching(sample) {
    const watch = this.watched;
    return !!(sample && watch && sample.conn === watch.conn && sample.ws === watch.ws
      && sample.conn && sample.conn.ws === watch.ws && Preview.liveConn(sample.conn));
  }

  _same(started, now) {
    return !!(now && started && this._watching(now) && now.conn === started.conn && now.ws === started.ws
      && now.conn.ws === started.ws
      && now.capture === started.capture && now.viewGen === started.viewGen
      && now.sharing === true && now.input === true && Preview.liveConn(now.conn));
  }

  _fence() {
    this.ticket += 1;
    this.epoch += 1;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const helper = this.helper;
    if (!helper || typeof helper.send !== 'function') return;
    try { helper.send('displayShotCancel', {}); } catch (_) { /* the helper is already gone */ }
  }

  // Stop, lock, revoked input, or a dead socket. One fence, then the stored pictures go.
  // A kick that finds the session already ended does not cancel the helper again.
  _endSession(sample, bag) {
    if (!this.watched && (!bag || (!bag.sent && bag.shots.size === 0))) return;
    const ask = this.ask;
    this._fence();
    this.watched = null;
    this._clear(sample, bag, ask);
    this.ask = null;
  }

  _stored() {
    for (const bag of this.bags.values()) {
      if (bag.sent || bag.shots.size > 0) return true;
    }
    return false;
  }

  _clear(sample, bag, ask) {
    if (!bag || (!bag.sent && bag.shots.size === 0)) return;
    bag.shots.clear();
    bag.bytes = 0;
    bag.sent = false;
    const epoch = Preview.askEpoch(ask);
    if (epoch == null || !sample || !Preview.liveConn(sample.conn) || sample.conn.ws !== sample.ws) return;
    try { this.send(sample.conn, { t: P.T.SCREEN_PREVIEW, epoch, clear: true }); } catch (_) { /* the socket is already gone */ }
  }

  _notice(sample, bag, code) {
    if (code !== 'os' && code !== 'permission') return;
    bag.notice = code;
    bag.noticeAt = this.now();
    const epoch = Preview.askEpoch(this.ask);
    if (epoch == null || !this._watching(sample)) return;
    try { this.send(sample.conn, { t: P.T.SCREEN_PREVIEW, epoch, unavailable: code }); } catch (_) { /* the socket is already gone */ }
  }

  _retain(bag, catalog) {
    const allowed = new Set(Preview.currentTargets(catalog).concat(this._listed(catalog)).map((t) => Preview.key(t.displayId, t.spaceId)));
    for (const id of bag.shots.keys()) {
      if (!allowed.has(id)) {
        bag.bytes -= bag.shots.get(id).jpeg.length;
        bag.shots.delete(id);
      }
    }
  }

  // Every space the catalog still lists, so a last-seen image of a desktop that is no
  // longer current can stay. A display that left the catalog cannot.
  _listed(catalog) {
    const out = [];
    const displays = catalog && Array.isArray(catalog.displays) ? catalog.displays : [];
    for (const d of displays) {
      if (!d || typeof d.id !== 'string') continue;
      const spaces = Array.isArray(d.spaces) ? d.spaces : [];
      for (const spaceId of spaces) {
        if (typeof spaceId === 'string') out.push({ displayId: d.id, spaceId });
      }
    }
    return out;
  }

  _store(bag, fence, jpeg, width, height) {
    const id = Preview.key(fence.displayId, fence.spaceId);
    const prev = bag.shots.get(id);
    if (prev) bag.bytes -= prev.jpeg.length;
    bag.shots.set(id, { jpeg, width, height, at: this.now(), capture: fence.capture, viewGen: fence.viewGen, stale: false });
    bag.bytes += jpeg.length;
    while (bag.shots.size > Preview.MAX_SHOTS || bag.bytes > Preview.MAX_STORE_BYTES) {
      let oldest = null;
      for (const [shotId, shot] of bag.shots) {
        if (!oldest || shot.at < oldest.at) oldest = { shotId, at: shot.at };
      }
      if (!oldest) break;
      bag.bytes -= bag.shots.get(oldest.shotId).jpeg.length;
      bag.shots.delete(oldest.shotId);
    }
  }

  _arm(ms) {
    if (this.timer || !this.watched) return;
    const delay = Math.max(250, Math.min(ms, Preview.REFRESH_MS));
    const epoch = this.epoch;
    this.timer = this.schedule(() => {
      this.timer = null;
      if (epoch !== this.epoch || !this.watched) return;
      this.kick();
    }, delay);
  }

  _scheduleNext(targets, bag) {
    if (!this.watched) return;
    const due = Preview.dueIn(targets, bag.shots, this.now());
    if (due == null) return;
    const gap = Math.max(0, Preview.MIN_GAP_MS - (this.now() - this.lastAt));
    this._arm(due === 0 ? Math.max(gap, 250) : Math.max(due, gap));
  }

  async _run() {
    this.running = true;
    try {
      do {
        this.again = false;
        await this._pass();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  async _pass() {
    this._prune();
    // A closed sheet with no history has nothing to capture or clear on lock.
    if (!this.watched && !this._stored()) return;
    const epoch = this.epoch;
    const ticketAt = this.ticket;
    const sample = this._sample();
    if (!sample || !sample.conn) {
      if (this.watched) this.cancel('session');
      return;
    }
    const bag = this._bag(sample.conn);
    if (!sample.sharing || !sample.input || !Preview.liveConn(sample.conn)) {
      this._endSession(sample, bag);
      return;
    }
    let locked;
    try { locked = await this.readLocked(); } catch (_) { return; }
    if (epoch !== this.epoch || ticketAt !== this.ticket) return;
    if (!Preview.screenUnlocked(locked)) {
      this._endSession(sample, bag);
      return;
    }
    if (!this._same(sample, this._sample())) return;
    if (!this._watching(sample)) return;
    if (!sample.catalog) return;
    this._retain(bag, sample.catalog);
    if (bag.notice === 'os') return;
    if (bag.notice === 'permission' && this.now() - bag.noticeAt < Preview.REFRESH_MS) {
      this._arm(Preview.REFRESH_MS - (this.now() - bag.noticeAt));
      return;
    }
    const targets = Preview.currentTargets(sample.catalog);
    const gapOk = this.now() - this.lastAt >= Preview.MIN_GAP_MS;
    const want = Preview.choose(targets, bag.shots, this.now(), gapOk);
    if (!want) {
      this._scheduleNext(targets, bag);
      return;
    }
    const displayNum = Preview.displayNumber(want.displayId);
    if (displayNum == null || !Preview.fenceReady({
      conn: sample.conn, capture: sample.capture, viewGen: sample.viewGen,
      displayId: want.displayId, spaceId: want.spaceId,
    })) return;
    let look;
    try { look = await this.freshLook(); } catch (_) { return; }
    if (epoch !== this.epoch || ticketAt !== this.ticket) return;
    if (!this._same(sample, this._sample())) return;
    let lockedAgain;
    try { lockedAgain = await this.readLocked(); } catch (_) { return; }
    if (epoch !== this.epoch || ticketAt !== this.ticket) return;
    if (!this._same(sample, this._sample())) return;
    if (!Preview.screenUnlocked(lockedAgain)) {
      this._endSession(sample, bag);
      return;
    }
    // Unknown and visible both fail closed. Try again later, without a screenshot.
    if (!Preview.missionHidden(look)) {
      this._arm(Preview.REFRESH_MS);
      return;
    }
    if (Preview.currentSpaceId(look, want.displayId) !== want.spaceId) return;
    if (!Preview.catalogPermits(sample.catalog, want.displayId)) return;
    const ticket = ++this.ticket;
    this.lastAt = this.now();
    let result;
    try {
      result = await Promise.race([
        this.helper.request('displayShot', { displayId: displayNum }, Preview.TIMEOUT_MS + 250)
          .then((value) => ({ value }))
          .catch((error) => ({ error })),
        this.wait(Preview.TIMEOUT_MS).then(() => ({ timeout: true })),
      ]);
    } catch (_) {
      return;
    }
    if (ticket !== this.ticket || epoch !== this.epoch) return;
    if (!result || result.timeout) {
      this.ticket += 1;
      try {
        if (this.helper && typeof this.helper.send === 'function') this.helper.send('displayShotCancel', {});
      } catch (_) { /* the helper is already gone */ }
      this._scheduleNext(targets, bag);
      return;
    }
    const after = this._sample();
    if (!this._same(sample, after)) return;
    if (result.error || !result.value) return;
    const body = result.value;
    if (body.unavailable) {
      // A stale or missed shot is not a reason to forget a last-seen picture.
      // macOS 13 stays refused. A missing Screen Recording permission is checked again later.
      if (body.unavailable === 'os' || body.unavailable === 'permission') {
        this._clear(after, bag, this.ask);
        this._notice(after, bag, body.unavailable);
        if (bag.notice === 'permission') this._arm(Preview.REFRESH_MS);
      }
      return;
    }
    let afterLocked;
    let afterLook;
    try {
      afterLocked = await this.readLocked();
      afterLook = await this.freshLook();
    } catch (_) {
      return;
    }
    if (ticket !== this.ticket || epoch !== this.epoch) return;
    const again = this._sample();
    if (!this._same(sample, again)) return;
    if (!Preview.screenUnlocked(afterLocked)) {
      this._endSession(again, bag);
      return;
    }
    if (!Preview.missionHidden(afterLook)) {
      this._arm(Preview.REFRESH_MS);
      return;
    }
    if (Preview.currentSpaceId(afterLook, want.displayId) !== want.spaceId) return;
    if (!Preview.catalogPermits(again.catalog, want.displayId)) return;
    if (String(body.displayId) !== want.displayId) return;
    const jpeg = Preview.decodeJpeg(body.jpeg);
    if (!Preview.acceptJpeg(jpeg, body.width, body.height)) return;
    this._store(bag, {
      displayId: want.displayId,
      spaceId: want.spaceId,
      capture: sample.capture,
      viewGen: sample.viewGen,
    }, jpeg, body.width, body.height);
    if (ticket !== this.ticket || epoch !== this.epoch || !this._same(sample, this._sample())) return;
    const ask = Preview.askEpoch(this.ask);
    if (ask == null) return;
    try {
      this.send(again.conn, {
        t: P.T.SCREEN_PREVIEW,
        epoch: ask,
        displayId: want.displayId,
        spaceId: want.spaceId,
        capture: sample.capture,
        viewGen: sample.viewGen,
        width: body.width,
        height: body.height,
        jpeg: jpeg.toString('base64'),
      });
      bag.sent = true;
      bag.notice = '';
    } catch (_) { /* the socket is already gone */ }
    this._scheduleNext(Preview.currentTargets(again.catalog), bag);
  }
}

module.exports = { DisplayShots };
