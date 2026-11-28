'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const app = new EventEmitter();
let shown = 0;
const ctx = vm.createContext({
  app: Object.assign(app, { focus() {} }),
  win: { isDestroyed: () => false, show: () => shown++, focus() {} },
  BrowserWindow: function () { assert.fail('created a window during quit'); },
});
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
vm.runInContext(section('let quitting =', 'let startHidden')
  + section('function createWindow()', 'function dockIcon()')
  + section('function showWindow()', 'function showUpdateWindow()')
  + section("app.on('second-instance'", "app.on('window-all-closed'"), ctx);
app.emit('activate');
assert.equal(shown, 1);
app.emit('before-quit');
app.emit('activate');
assert.equal(shown, 1);
ctx.win = null;
app.emit('second-instance');
vm.runInContext('createWindow()', ctx);
console.log('quit-no-revive ok');
