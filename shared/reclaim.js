// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Reclaim after the phone grace window (#192). A Wi-Fi gap longer than PHONE_GRACE_MS ends the
// plain-hello retry. A durable return intent permits only hello {rc:1, resume:'0'} to the same Mac:
//   • A host that advertises beacon rc:1 (the single-session Mac) accepts it when the token is the
//     paired phone's and nobody else holds the session. Busy is never a takeover: it does not yield
//     a guest session, evict whoever authenticated meanwhile, or end another phone's grace.
//   • The check runs again when Server.authenticate actually commits. Fast files can defer that
//     for up to 1.5s, and Disconnect, Forget, Stop, or revoke in that gap still wins.
//   • A host that does not understand rc still sees hello {resume} and treats it as a socket move,
//     which fails closed. It must not be a plain phone hello: that takes the session.
//   • Disconnect, Forget and Stop stay in force across a delayed callback and a process restart
//     (the Mac remembers its last owner). A replacement revokes that positive consent.
'use strict';

// What an unauthenticated first message is. reclaim:true is the Mac that knows this capability.
// Without it, a reclaim hello falls through to 'resume' (fail closed, no takeover).
function unauthRoute(msg, opts) {
  const reclaim = !!(opts && opts.reclaim);
  if (!msg || typeof msg.t !== 'string') return 'reject';
  if (msg.t === 'hello' && reclaim && msg.rc === 1) return 'reclaim';
  if (msg.t === 'hello' && typeof msg.resume === 'string') return 'resume';
  if (msg.t === 'hello' || msg.t.startsWith('pair.')) return 'preauth';
  return 'reject';
}

// Mac side, after the token already matched this paired record.
// Busy (this Mac is a guest, someone else is authenticated, or another phone's grace) refuses.
// It does not mean "take the session". The phone may retry only while both peers retain consent.
// A revoked owner is final; a sleeping/busy host never yields its current session.
function reclaimDecision(s) {
  if (!s || !s.phone) return { ok: false, code: 'bad_message', message: 'Reclaim is only for a paired phone' };
  if (s.blocked) return { ok: false, code: 'released', message: 'The Mac disconnected' };
  if (s.busy) return { ok: false, code: 'busy', message: 'Connected to another device' };
  if (s.currentAuthed && s.currentId && s.currentId !== s.selfId) return { ok: false, code: 'busy', message: 'In use by another device' };
  if (s.graceId && s.graceId !== s.selfId) return { ok: false, code: 'busy', message: 'In use by another phone' };
  return { ok: true };
}

module.exports = { unauthRoute, reclaimDecision };
