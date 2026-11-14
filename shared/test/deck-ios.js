// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The iPhone's Deck catalog (ios/TwinDesk/Core/DeckCatalog.swift) is generated from the computer's
// (shared/deck-catalog.js, shared/deck-model.js): this checks it was regenerated after a change.
// Run with: node shared/test/deck-ios.js   (to fix: node ios/tools/gen-deck.js)
'use strict';

const assert = require('assert');
const fs = require('fs');
const { make, OUT } = require('../../ios/tools/gen-deck.js');

assert.strictEqual(fs.readFileSync(OUT, 'utf8'), make(), 'DeckCatalog.swift is out of date: run node ios/tools/gen-deck.js');
console.log('deck-ios: ok');
