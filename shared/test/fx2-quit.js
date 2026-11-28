'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = require.resolve('../fx2');
const app = Object.assign(new EventEmitter(), { isReady: () => true });
let child;
const electron = { app, utilityProcess: { fork() {
  child = new EventEmitter();
  child.postMessage = () => {};
  child.kill = () => child.emit('exit', 0);
  return child;
} } };
const moduleStub = { exports: {} };
const warnings = [];
vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
  module: moduleStub, __dirname: path.dirname(file), clearTimeout,
  process: { versions: { electron: '44.10.1' }, type: 'browser', env: {} },
  require: (id) => id === 'electron' ? electron : require(id),
  console: { warn: (message) => warnings.push(message) },
});
const { Fx2 } = moduleStub.exports;

const crashed = new Fx2();
crashed.need('test', true);
child.emit('exit', 0); // Even a zero exit is unexpected while the app is running.
assert.equal(crashed.state, 'in-process');
assert.equal(warnings.length, 1);
assert.equal(app.listenerCount('will-quit'), 0, 'a child that is gone leaves no listener on the app');
crashed.close();

const quitting = new Fx2();
quitting.need('test', true);
app.emit('will-quit');
if (quitting.child) child.emit('exit', 0);
assert.equal(warnings.length, 1);
assert.equal(quitting.engine, undefined);
assert.equal(app.listenerCount('will-quit'), 0);
console.log('fx2-quit ok');
