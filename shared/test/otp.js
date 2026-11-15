// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/otp.js: the one-time code in a notification (Copy on Overview and the toast), and only that.
'use strict';

const assert = require('assert');
const { otpOf } = require('../otp.js');

const cases = [
  ['Your one-time code is 482913. Don’t share it.', '482913'],
  ['G-482913 is your Google verification code.', '482913'],
  ['OTP: 4829-13 valid 5 min', '482913'],
  ['Verification code: 123 456', '123456'],
  ['Use 739201 to sign in to Instagram', '739201'],
  ['Your code 1234 for order 99887766', '1234'],
  ['Your total is 12.50, code 9921', '9921'],
  ['ඔබගේ කේතය 556677', '556677'],
  ['Order 99887766 shipped', ''],
  ['Meeting at 10:30, room 2024', ''],
  ['PIN 2024 expires', ''],
  ['Call me at 0771234567 about the code', ''],
  // Not codes: money, card/account/order numbers, other kinds of "code", dates, phone numbers.
  ['Your code is ready. Pay Rs. 5000 at the counter', ''],
  ['Use your PIN at checkout to pay $1250.', ''],
  ['Verification complete: €4500 transferred.', ''],
  ['Your login was recorded on 2026-10-08 at 12:30.', ''],
  ['For verification support, dial +44 7911 123456.', ''],
  ['Order #482910 has shipped! Use your tracking code at the link.', ''],
  ['Your tracking code is 84920184 for order 192837.', ''],
  ['Login alert for card ending 4821.', ''],
  ['Verification requested for account 948201.', ''],
  ['Delivery to zip code 94043 is scheduled.', ''],
  ['Login failed with error code 4040.', ''],
  ['Use promo code 5521 for 10% off', ''],
  // Codes next to those words still count.
  ['Your code is 4821. Card ending 9911 was used.', '4821'],
  ['Error code 12 — your verification code is 663201', '663201'],
  ['G-482913 is your Google verification code', '482913'],
  ['', ''],
];
for (const [text, want] of cases) assert.strictEqual(otpOf(text), want, JSON.stringify(text));
console.log('otp: ok');
