// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A log server for testing: every device (Windows, Mac, Android) posts its log lines here
// (POST /log {device, lines}); they are printed with the device's name and appended to
// tools/logs/<device>.log. Run on the PC the devices are told about:
//   node tools/logserver.js [port]        (default 47900; listens on every interface)
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const port = Number(process.argv[2]) || 47900;
const dir = path.join(__dirname, 'logs');
fs.mkdirSync(dir, { recursive: true });

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.statusCode = 200; return res.end('TwinDesk log server\n'); }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      const { device, lines } = JSON.parse(body);
      const name = String(device || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 60);
      const list = (Array.isArray(lines) ? lines : []).map((l) => String(l).slice(0, 2000));
      for (const l of list) console.log(`[${name}] ${l}`);
      fs.appendFileSync(path.join(dir, name + '.log'), list.map((l) => l + '\n').join(''));
      res.statusCode = 204;
    } catch (_) { res.statusCode = 400; }
    res.end();
  });
}).listen(port, '0.0.0.0', () => console.log(`log server on port ${port}, writing to ${dir}`));
