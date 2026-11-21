// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { randomBytes } = require('node:crypto');
const { connectionOf } = require('../shared/asked-send');
const { OS, T } = require('../shared/protocol');

const MAX_TASKS = 32;
const MAX_AGE = 24 * 60 * 60 * 1000;
const ID = /^[a-f0-9]{32}$/;
const failure = (code, error) => ({ code, body: { ok: false, error } });
const success = (fields) => ({ code: 200, body: { ok: true, ...fields } });

class TaskAlerts {
  constructor(peer) {
    this.peer = peer;
    this.owner = null;
    this.tasks = new Map();
    peer.on(`t:${T.TASK_ALERT_POLICY}`, (msg, ctx, ws) => {
      if (typeof msg.on !== 'boolean' || !this.live(ctx, ws)) return;
      if (this.owner?.ctx === ctx && this.owner.ws === ws && msg.on) return;
      this.tasks.clear();
      this.owner = msg.on ? { ctx, ws } : null;
    });
    for (const event of ['client', 'closed', 'transport']) {
      peer.on(event, () => {
        if (this.owner && !this.live(this.owner.ctx, this.owner.ws)) {
          this.owner = null;
          this.tasks.clear();
        }
      });
    }
  }

  live(ctx, ws) {
    return ctx === this.peer.current && ctx?.os === OS.ANDROID && !!ws &&
      ws === this.peer.outbound(ctx) && !!connectionOf(ctx, ws);
  }

  clear() { this.tasks.clear(); }

  start(body) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)) {
      return failure(400, 'Invalid task label');
    }
    if (!this.owner || !this.live(this.owner.ctx, this.owner.ws)) {
      return failure(409, 'Connect an Android phone and enable Task alerts on it');
    }
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.until <= now) this.tasks.delete(id);
    }
    if (this.tasks.size >= MAX_TASKS) return failure(429, 'Too many pending task alerts');
    const id = randomBytes(16).toString('hex');
    this.tasks.set(id, { title, until: now + MAX_AGE });
    return success({ id });
  }

  finish(body) {
    const { id, ok } = body;
    if (typeof id !== 'string' || !ID.test(id) || typeof ok !== 'boolean') {
      return failure(400, 'Invalid task alert');
    }
    const task = this.tasks.get(id);
    this.tasks.delete(id);
    if (!task || task.until <= Date.now() || !this.owner || !this.live(this.owner.ctx, this.owner.ws)) {
      return failure(409, 'Task alert session ended; start a new watch');
    }
    this.peer.send(this.owner.ctx, { t: T.TASK_ALERT, id, title: task.title, ok });
    return success();
  }

  cancel(body) {
    const { id } = body;
    if (typeof id !== 'string' || !ID.test(id)) {
      return failure(400, 'Invalid task alert');
    }
    this.tasks.delete(id);
    return success();
  }
}

module.exports = { TaskAlerts };
