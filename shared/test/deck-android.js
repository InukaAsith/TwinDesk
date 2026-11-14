// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's Deck catalog and symbols (DeckCatalog.kt) are generated from the computer's
// (shared/deck-catalog.js, shared/deck-icons.js): this checks they were regenerated after a change.
// Run with: node shared/test/deck-android.js   (to fix: node android/tools/gen-deck.js)
'use strict';

const assert = require('assert');
const fs = require('fs');
const { make, OUT } = require('../../android/tools/gen-deck.js');

assert.strictEqual(fs.readFileSync(OUT, 'utf8'), make(), 'DeckCatalog.kt is out of date: run node android/tools/gen-deck.js');
console.log('deck-android: ok');
