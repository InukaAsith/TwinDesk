'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../settings');
const meshSettings = require('../mesh/settings');

function fixture() {
  const document = { activeElement: null, createElement(tag) {
    return { tag, children: [], value: '', append(child) { this.children.push(child); }, setAttribute() {},
      get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
      reportValidity() { const n = this.valueAsNumber; return Number.isInteger(n) && n >= this.min && n <= this.max; },
      click() { this.onclick(); } };
  } };
  const window = { MacShareProtocol: require('../../shared/protocol') }, sent = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui-kit.js'), 'utf8'), { window, document, I18n: { t: x => x } });
  const control = window.UI.customSize(value => sent.push(value));
  const [widthLabel, , heightLabel, apply] = control.el.children;
  return { control, width: widthLabel.children[1], height: heightLabel.children[1], apply, document, sent };
}

test('custom dimensions submit the existing WxH setting and remain compatible with saved sizes', () => {
  const f = fixture(); f.control.set([1920, 1200]); f.apply.click();
  assert.deepEqual(f.sent, ['1920x1200']);
  assert.equal(settings.normalize({ pcScreen: { extendSize: f.sent[0] } }).pcScreen.extendSize, '1920x1200');
  for (const [width, height] of [[320, 7680], [7680, 320]]) {
    f.control.set([width, height]); f.apply.click();
    assert.equal(f.sent.at(-1), `${width}x${height}`);
  }
});

test('invalid dimensions are kept for correction and never submitted', () => {
  for (const value of ['', '319', '7681', '1920.5', 'abc']) {
    for (const field of ['width', 'height']) {
      const f = fixture(); f.control.set([1920, 1200]); f[field].value = value; f.apply.click();
      assert.deepEqual(f.sent, []); assert.equal(f[field].value, value);
    }
  }
});

test('state updates preserve both edits while either field has focus; Enter applies', () => {
  const f = fixture(); f.control.set([1920, 1200]);
  f.width.value = '2560'; f.height.value = '1600'; f.document.activeElement = f.height;
  f.control.set([1920, 1080]);
  assert.equal(f.width.value, '2560'); assert.equal(f.height.value, '1600');
  let prevented = false; f.height.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(f.sent, ['2560x1600']);
  f.document.activeElement = null; f.control.set([3840, 2160]);
  assert.equal(f.width.value, 3840); assert.equal(f.height.value, 2160);
});

test('Follow Size persists while custom dimensions change, without changing existing numeric presets', () => {
  for (const model of [settings, meshSettings]) {
    const state = model.normalize({ pcScreen: { maxHeight: 'extend', extendSize: '1920x1200' } });
    assert.equal(state.pcScreen.maxHeight, 'extend');
    model.apply(state, 'pcScreen', { extendSize: '2560x1600' });
    assert.equal(state.pcScreen.maxHeight, 'extend');
    assert.equal(state.pcScreen.extendSize, '2560x1600');
    for (const preset of [0, 1080, 1440, 2160]) {
      assert.equal(model.normalize({ pcScreen: { maxHeight: preset } }).pcScreen.maxHeight, preset);
    }
    assert.equal(model.normalize({ pcScreen: { maxHeight: 'invalid' } }).pcScreen.maxHeight, 1080);
  }
});
