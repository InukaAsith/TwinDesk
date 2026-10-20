// TwinDesk log file: everything the main process prints (console.log / warn / error) is also written
// to <userData>/logs/main.log, so a problem seen on a device can be read afterwards (the installed
// app has no console). The file is capped: past MAX_BYTES it moves to main.log.1 (the one before is
// dropped). Plain Node, no Electron: the app passes the folder.
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 1024 * 1024;

function install(dir, { maxBytes = MAX_BYTES, target = console, name = 'main.log' } = {}) {
  let file = null;
  let size = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, name);
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch (e) {
    return { file: null, stop() {} };
  }
  const write = (level, args) => {
    try {
      const line = `${new Date().toISOString()} ${level} ${util.format(...args)}\n`;
      if (size + line.length > maxBytes) {
        try { fs.renameSync(file, file + '.1'); } catch (e) { /* the old one stays */ }
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += line.length;
    } catch (e) { /* a log must never break the app */ }
  };
  const orig = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    orig[level] = target[level].bind(target);
    target[level] = (...args) => {
      write(level.toUpperCase(), args);
      orig[level](...args);
    };
  }
  write('INFO', ['--- start', process.argv.slice(1).join(' ').slice(0, 200)]);
  return {
    file,
    write: (...args) => write('INFO', args),
    stop() { for (const level of Object.keys(orig)) target[level] = orig[level]; },
  };
}

module.exports = { install, MAX_BYTES };
