// The pooled features on top of a test node (lib/mesh.js): the Clip and Notifs of shared/mesh.js
// with fakes for the OS clipboard, the helper process and the notification centre.
'use strict';

const { EventEmitter } = require('events');
const { Clip } = require('../../clipboard.js');
const { Notifs } = require('../../notifs.js');

// The clipboard as a text box: readText/writeText, and every write is kept.
function fakeClipboard() {
  const cb = {
    text: '',
    writes: [],
    readText() {
      return cb.text;
    },
    writeText(t) {
      cb.text = String(t);
      cb.writes.push(String(t));
    },
  };
  return cb;
}

// The helper process: the events the Mac helper sends, and every request/send it gets.
class FakeHelper extends EventEmitter {
  constructor() {
    super();
    this.running = true;
    this.sent = [];
    this.concealed = false;
    this.readable = true;
  }

  send(name, args) {
    this.sent.push([name, args]);
  }

  request(name) {
    if (name === 'clipboardInfo') return Promise.resolve({ concealed: this.concealed });
    if (name === 'notifWatch') return Promise.resolve({ readable: this.readable });
    return Promise.resolve({});
  }

  // A copy made in the OS (the helper's clipboard watch).
  copy(text, { concealed = false, initial = false } = {}) {
    this.emit('event', 'clipboard', { concealed, initial });
    return text;
  }

  // A notification of this Mac's notification centre.
  notif(ev) {
    this.emit('event', 'notif', { app: 'com.example.mail', appName: 'Mail', title: 'Hi', body: 'Body', at: Date.now(), ...ev });
  }
}

// What the Notification class of Electron does, for the tests: the shown ones are kept.
function fakeNotificationClass(shown) {
  return class FakeNotification extends EventEmitter {
    static isSupported() {
      return true;
    }

    constructor(opts) {
      super();
      this.opts = opts;
      shown.push(this);
    }

    show() {
      this.shownAt = Date.now();
    }
  };
}

// The pooled features of one node. settings: optional overrides of clipboard / notifs.
function pooled(n, { clip = {}, notifs = {}, name = n.name } = {}) {
  const settings = {
    clipboard: { enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, historySize: 20, ...clip },
    notifs: { send: true, receive: true, hideText: false, muted: [], ...notifs },
  };
  const clipboard = fakeClipboard();
  const helper = new FakeHelper();
  const shown = [];
  const Notification = fakeNotificationClass(shown);
  const clipFeature = new Clip({ bus: n.hub.bus, mesh: n.mesh, getSettings: () => settings, clipboard, helper });
  const notifFeature = new Notifs({
    bus: n.hub.bus,
    mesh: n.mesh,
    getSettings: () => settings,
    helper,
    selfName: name,
    Notification,
  });
  // The features start after the links came up (as in the app): they tell the others their policy now.
  clipFeature.sendPolicy();
  notifFeature.sendPolicy();
  return { settings, clipboard, helper, shown, clip: clipFeature, notifs: notifFeature, node: n };
}

module.exports = { fakeClipboard, FakeHelper, fakeNotificationClass, pooled };
