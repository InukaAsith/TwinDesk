// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// ../sender.js with a first session number of its own: a sender on a link of its own (shared/pcscreen-set.js)
// starts high, so its numbers never meet those of the selected device's sender on the same link (the
// Mac routes by session).
const Sender = require('../sender');

class MeshSender extends Sender {
  constructor(link, base = 0) {
    super(link);
    this.counter = base;
  }
}

module.exports = MeshSender;
