// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The `Host twindesk` entry in ~/.ssh/config, so `ssh twindesk` opens a shell on the paired
// computer on every OS. Only our marked block is touched; the rest of the file stays byte for byte,
// and a one-time backup is kept. Blocks written by older versions (`macshare-pc`) are removed too.
// Multi-device: one block per device too, `Host twindesk-<its name>` (aliasFor), so `ssh twindesk-ryzen9`
// reaches that device whichever is selected; `twindesk` stays the selected device's.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ALIAS = 'twindesk';
const SSH_DIR = path.join(os.homedir(), '.ssh');
const CONFIG = path.join(SSH_DIR, 'config');
const begin = (alias) => `# >>> ${alias} (managed by TwinDesk, do not edit)`;
const end = (alias) => `# <<< ${alias} (end)`;
const OLD = [['# >>> macshare', '# <<< macshare']];
const OLD_END = '# <<< twindesk'; // the default block's end before there were several

// A device's alias: twindesk-<its name>, letters, digits and dashes (twindesk-<id> without a usable name).
function aliasFor(name, id) {
  const slug = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return `${ALIAS}-${slug || String(id || 'device').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase()}`;
}

// A value for the config file, quoted when it has spaces (Windows paths often do).
const quote = (v) => (/[\s"]/.test(v) ? `"${String(v).replace(/"/g, '')}"` : String(v));

function strip(text, begin, end) {
  const start = text.indexOf(begin);
  const stop = start < 0 ? -1 : text.indexOf(end, start);
  if (start < 0 || stop < 0) return text;
  let a = start;
  if (text[a - 1] === '\n' && text[a - 2] === '\n') a--; // the blank line we added before it
  let b = stop + end.length;
  if (text[b] === '\r') b++;
  if (text[b] === '\n') b++;
  return text.slice(0, a) + text.slice(b);
}

// host: {address, port, user, identityFile, knownHostsFile}, or null to remove the entry. alias: whose block.
function setHost(host, alias = ALIAS) {
  let text = '';
  try {
    text = fs.readFileSync(CONFIG, 'utf8');
  } catch { /* no config yet */ }
  const before = text;
  text = strip(text, begin(alias), end(alias));
  if (alias === ALIAS) for (const [b, e] of [[begin(ALIAS), OLD_END], ...OLD]) text = strip(text, b, e);
  if (host) {
    const lines = [
      `Host ${alias}`,
      `  HostName ${host.address}`,
      `  Port ${Number(host.port) || 22}`,
      `  User ${quote(host.user)}`,
      `  IdentityFile ${quote(host.identityFile)}`,
      '  IdentitiesOnly yes',
      `  HostKeyAlias ${alias}`,
      `  UserKnownHostsFile ${quote(host.knownHostsFile)}`,
      '  StrictHostKeyChecking yes',
    ];
    text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${begin(alias)}\n${lines.join('\n')}\n${end(alias)}\n`;
  }
  if (text === before) return;
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  const backup = `${CONFIG}.before-twindesk`;
  if (fs.existsSync(CONFIG) && !fs.existsSync(backup) && !fs.existsSync(`${CONFIG}.before-macshare`)) fs.copyFileSync(CONFIG, backup);
  const mode = fs.existsSync(CONFIG) ? fs.statSync(CONFIG).mode & 0o777 : 0o600;
  fs.writeFileSync(CONFIG, text, { mode });
}

// Pinned host keys for the aliases, one per line.
function knownHosts(keys, aliases = [ALIAS]) {
  return [].concat(aliases).flatMap((a) => keys.map((k) => `${a} ${k}`)).join('\n') + '\n';
}

module.exports = { ALIAS, setHost, knownHosts, aliasFor };
