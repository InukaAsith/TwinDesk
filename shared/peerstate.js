// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: what each device last said about itself, and what we last told it, so a feature that
// follows the selection (the hub's facade) or a route (sound, mic) gets it again when it moves there.
//
// A one-to-one feature resets what it knows of the other side on 'welcome' and waits for that side's
// policy or state. The other side sends those once, as its own session starts, and after that only
// when they change. In the mesh a selection change is a 'welcome' only on this side: the device sent
// them while it wasn't selected (so they were dropped), and it doesn't send them again. Sound to a
// device then never starts, Monitor 2 never learns that it shares, and so on.
//
// Heard: the last message of each REMEMBER type from each device, kept whichever device is selected,
// and played to a facade or route right after its 'welcome' for that device. Nothing goes on the wire.
// Said: the policies a facade or route sent to its device. When it leaves that device (a selection
// change, not a disconnect), GOODBYE tells the device they are off: the device stops what it did for
// us (capturing its screen, sending its sound), and the next 'welcome' policy is a change it answers.
'use strict';

// Messages that say how a device stands, the latest of each superseding the rest.
const REMEMBER = new Set([
  'audio.policy', // {accept}: it plays our sound
  'mic.policy', // {accept}: it uses our microphone
  'cam.policy', // {share}: it lets us see its camera
  'screen.state', // {on, mode, remote, modes}: what it shares
  'screen.policy', // {accept}: its viewer wants our picture
  'papp.policy', // {accept}: it shows this computer's apps
  'wol.info', // {macs, address}: how to wake it
  'ssh.key', // {pub}: its Terminal's key
  'dev.state', // its device state (the Overview's controls)
  'hub.state', // a phone's Phone hub permissions
  'call.state', // a phone's call
]);

// The policies that are switched off on the device a facade or route leaves: type -> the field.
const GOODBYE = {
  'audio.policy': 'accept',
  'mic.policy': 'accept',
  'cam.policy': 'share',
  'screen.policy': 'accept',
};

// The last REMEMBER message of each type from each device id.
class Heard {
  constructor() {
    this.by = new Map(); // id -> Map(type -> msg)
  }

  note(id, msg) {
    if (!id || !msg || !REMEMBER.has(msg.t)) return;
    if (!this.by.has(id)) this.by.set(id, new Map());
    this.by.get(id).set(msg.t, msg);
  }

  // Copies, without ask (an ask is answered when it comes, not again on every switch).
  replay(id) {
    const m = id && this.by.get(id);
    if (!m) return [];
    return [...m.values()].map((x) => {
      const c = { ...x };
      delete c.ask;
      return c;
    });
  }

  // The device went away: its next session says it all again.
  forget(id) {
    this.by.delete(id);
  }
}

// The GOODBYE policies one facade or route sent, for the device it sends to now.
class Said {
  constructor() {
    this.id = null;
    this.on = new Map(); // type -> true while we told it the policy is on
  }

  note(id, msg) {
    if (!id || !msg) return;
    const field = GOODBYE[msg.t];
    if (!field) return;
    if (id !== this.id) {
      this.id = id;
      this.on.clear();
    }
    if (msg[field] === true) this.on.set(msg.t, true);
    else this.on.delete(msg.t);
  }

  // The messages that switch off what we told `id`, once; then nothing is left to switch off.
  goodbyes(id) {
    if (!id || id !== this.id) return [];
    const out = [...this.on.keys()].map((t) => ({ t, [GOODBYE[t]]: false }));
    this.on.clear();
    this.id = null;
    return out;
  }

  forget(id) {
    if (id && id === this.id) {
      this.on.clear();
      this.id = null;
    }
  }
}

module.exports = { Heard, Said, REMEMBER, GOODBYE };
