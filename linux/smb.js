// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Network folders (port of windows/smb.js): this computer shares one folder with the other one
// through Samba, and the other computer's shared folder is connected here through GVFS.
// Sharing: one password prompt (pkexec) installs Samba if it's missing, makes `macshare`, a
// system account that can't log in, with a random Samba password, and the [MacShare] share in
// /etc/samba/twindesk.conf (included from smb.conf). Files written through it belong to this
// user (force user). The firewall (ufw / firewalld) lets Samba in; SELinux labels the folder.
// Connecting: `gio mount smb://WORKGROUP;user@address/share` with the password on stdin, so the
// folder shows in the file manager's sidebar like any network place; no root needed.
// Credentials only travel over the paired link; ours are kept with Electron safeStorage
// (the desktop's keyring) when it's there, else in a file only this user can read.
const { app, safeStorage, shell } = require('electron');
const os = require('os');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');

const T = P.T;
const SHARE = 'MacShare';
const USER = 'macshare';
const CONF = '/etc/samba/twindesk.conf';
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // POSIX shell quoting

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 45000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const e = new Error(String(stderr || stdout || err.message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' ') || err.message);
      e.code = err.code;
      reject(e);
    });
  });
}

class Smb {
  // opts: link, settings (shared), save(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.credFile = path.join(app.getPath('userData'), 'smb-share.bin');
    this.busy = '';         // 'setup' | 'remove' | 'mount' while working
    this.message = '';      // last problem with our share
    this.peerState = null;  // the other computer's smb.state about our share
    this.mac = null;        // {share, user, password} from the other computer's smb.offer (memory only)
    this.mounted = null;    // {uri, path} once its folder is connected here
    this.mountMessage = '';
    this.sharePath = '';

    this.link.on('welcome', () => this._offer());
    this.link.on(T.SMB_STATE, (m) => { if (m.share === SHARE) { this.peerState = { mounted: !!m.mounted, error: m.error || '' }; this.onChange(); } });
    this.link.on(T.SMB_OFFER, (m) => this._onMacOffer(m));
    this.link.on(T.SMB_REVOKE, (m) => this._unmount(m.share));
    this.checkShare();
  }

  get cfg() {
    return this.settings.files;
  }

  get defaultFolder() {
    return path.join(os.homedir(), 'MacShare'); // the same name the Mac and the PC use
  }

  // ---- this computer shares a folder ----

  _creds() {
    try {
      if (!fs.existsSync(this.credFile)) return null;
      const raw = fs.readFileSync(this.credFile);
      const text = raw[0] === 0x7b ? raw.toString('utf8') : safeStorage.decryptString(raw); // '{': no keyring when it was saved
      return JSON.parse(text);
    } catch (_) { return null; }
  }

  _saveCreds(c) {
    const text = JSON.stringify(c);
    let data = Buffer.from(text);
    try { if (safeStorage.isEncryptionAvailable()) data = safeStorage.encryptString(text); } catch (_) { /* plain, 0600 */ }
    fs.writeFileSync(this.credFile, data, { mode: 0o600 });
  }

  _offer() {
    const c = this._creds();
    if (this.cfg.shareOn && c) this.link.send({ t: T.SMB_OFFER, share: SHARE, user: c.user, password: c.password, port: 445 });
  }

  // One switch: on → share the folder (default ~/MacShare); the password prompt only comes the
  // first time or after the folder changed. Off → the other computer disconnects it; the share and
  // the account stay, so switching on again needs no prompt.
  async setShareOn(on) {
    if (this.busy) return;
    if (!on) {
      this.cfg.shareOn = false;
      this.save();
      this.link.send({ t: T.SMB_REVOKE, share: SHARE });
      this.peerState = null;
      return this.onChange();
    }
    const folder = this.cfg.shareFolder || this.defaultFolder;
    try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { return this._msg('Can’t create ' + folder + ': ' + e.message); }
    await this.checkShare();
    if (this._creds() && this.sharePath === folder) {
      this.cfg.shareOn = true;
      this.cfg.shareFolder = folder;
      this.save();
      this.message = '';
      this._offer();
      return this.onChange();
    }
    await this.share(folder);
  }

  // Choose… a different folder: shared right away if sharing is on, else remembered for later.
  async chooseFolder(folder) {
    if (!folder) return;
    if (this.cfg.shareOn) return this.share(folder);
    this.cfg.shareFolder = folder;
    this.save();
    this.onChange();
  }

  // One script as root: Samba, the account and its password, the share, the firewall.
  async share(folder) {
    if (this.busy) return;
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return this._msg('Pick a folder first');
    if (/[\n\r]/.test(folder)) return this._msg('That folder’s name can’t be shared');
    const me = os.userInfo().username;
    if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(me)) return this._msg('Unexpected user name');
    const password = 'Ms-' + crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x') + '!7a';
    const pwFile = path.join(app.getPath('userData'), 'smb-pw.tmp');
    fs.writeFileSync(pwFile, password, { mode: 0o600 });
    const script = `
set -e
PW=$(cat ${q(pwFile)}); rm -f ${q(pwFile)}
if ! command -v smbd >/dev/null 2>&1; then
  if [ -e /etc/NIXOS ]; then echo "On NixOS, enable services.samba.enable = true; in configuration.nix" >&2; exit 3;
  elif command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q samba >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q samba >/dev/null
  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive -q install samba >/dev/null
  elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed samba >/dev/null
  else echo "Install Samba first (no package manager found)" >&2; exit 3; fi
fi
id ${USER} >/dev/null 2>&1 || useradd -r -M -d /nonexistent -s "$(command -v nologin || echo /bin/false)" -c 'TwinDesk file sharing (network only)' ${USER}
printf '%s\\n%s\\n' "$PW" "$PW" | smbpasswd -s -a ${USER} >/dev/null
smbpasswd -e ${USER} >/dev/null
mkdir -p /etc/samba
[ -f /etc/samba/smb.conf ] || printf '[global]\\n   workgroup = WORKGROUP\\n' > /etc/samba/smb.conf
printf '# TwinDesk: the folder shared with the other computer (managed by TwinDesk)\\n[${SHARE}]\\n   comment = TwinDesk\\n   path = %s\\n   valid users = ${USER}\\n   force user = %s\\n   read only = no\\n   browseable = no\\n   create mask = 0644\\n   directory mask = 0755\\n' ${q(folder)} ${q(me)} > ${CONF}
grep -qxF 'include = ${CONF}' /etc/samba/smb.conf || printf '\\ninclude = ${CONF}\\n' >> /etc/samba/smb.conf
if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then chcon -R -t samba_share_t ${q(folder)} || true; setsebool -P samba_enable_home_dirs on || true; fi
if systemctl is-active -q ufw 2>/dev/null; then ufw allow samba >/dev/null 2>&1 || ufw allow 445/tcp >/dev/null; fi
if firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --permanent --add-service=samba >/dev/null && firewall-cmd --reload >/dev/null; fi
for s in smbd smb; do if systemctl cat $s >/dev/null 2>&1; then systemctl enable $s >/dev/null 2>&1 || true; systemctl restart $s; fi; done
`;
    this._busy('setup');
    try {
      await run('pkexec', ['sh', '-c', script], { timeout: 600000 });
      this._saveCreds({ user: USER, password });
      this.cfg.shareOn = true;
      this.cfg.shareFolder = folder;
      this.save();
      this.message = '';
      await this.checkShare();
      this._offer();
    } catch (e) {
      this.message = e.code === 126 ? 'The password prompt was closed' : 'Sharing failed: ' + e.message;
    } finally {
      try { fs.unlinkSync(pwFile); } catch (_) { /* removed by the script */ }
      this._busy('');
    }
  }

  // Stop sharing: the other computer disconnects; the share and the account are removed (root).
  async unshare() {
    if (this.busy) return;
    this.link.send({ t: T.SMB_REVOKE, share: SHARE });
    this._busy('remove');
    try {
      await run('pkexec', ['sh', '-c', `
rm -f ${CONF}
[ -f /etc/samba/smb.conf ] && sed -i '\\#^include = ${CONF}$#d' /etc/samba/smb.conf
smbpasswd -x ${USER} >/dev/null 2>&1 || true
userdel ${USER} 2>/dev/null || true
smbcontrol all reload-config 2>/dev/null || true
`], { timeout: 120000 });
      this.message = '';
    } catch (e) {
      this.message = e.code === 126 ? 'Cancelled. The folder is still shared.' : e.message;
    }
    try { fs.unlinkSync(this.credFile); } catch (_) { /* none */ }
    this.cfg.shareOn = false;
    this.save();
    this.peerState = null;
    await this.checkShare();
    this._busy('');
  }

  // Is our share still set up? (its file is readable by everyone; no prompt)
  async checkShare() {
    try {
      const m = /^\s*path\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(CONF, 'utf8'));
      this.sharePath = m ? m[1] : '';
    } catch (_) { this.sharePath = ''; }
    this.onChange();
  }

  // ---- the other computer shares a folder: connect it here ----

  async _onMacOffer(m) {
    if (typeof m.share !== 'string' || typeof m.user !== 'string' || typeof m.password !== 'string') return;
    this.mac = { share: m.share, user: m.user, password: m.password };
    if (!this.cfg.mountMac) return this._state(m.share, false, 'Turned off on the other computer');
    await this.mount();
  }

  _uri() {
    const addr = String(this.link.snapshot().link.address || '').replace(/^::ffff:/, '');
    if (!addr || !this.mac) return '';
    const host = addr.includes(':') ? '[' + addr + ']' : addr;
    return 'smb://WORKGROUP;' + encodeURIComponent(this.mac.user) + '@' + host + '/' + encodeURIComponent(this.mac.share);
  }

  async mount() {
    const m = this.mac;
    const uri = this._uri();
    if (!m || !uri || this.busy) return;
    if (!/^[\w.$ -]+$/.test(m.share)) return this._state(m.share, false, 'Bad share name');
    this._busy('mount');
    try {
      let local = await localPath(uri);
      if (!local) {
        await gioMount(uri, m.password);
        local = await localPath(uri);
      }
      this.mounted = { uri, path: local };
      this.mountMessage = '';
      this._state(m.share, true);
    } catch (e) {
      this.mounted = null;
      this.mountMessage = 'Couldn’t connect {name}’s folder: ' + e.message;
      this._state(m.share, false, e.message);
    }
    this._busy('');
  }

  async _unmount(share) {
    if (this.mounted) await run('gio', ['mount', '-u', this.mounted.uri]).catch(() => {});
    this.mounted = null;
    if (share) { this.mac = null; this._state(share, false); }
    this.onChange();
  }

  // Switch "Connect the other computer's shared folder" changed.
  applyMount() {
    if (this.cfg.mountMac && this.mac) this.mount();
    else if (!this.cfg.mountMac && this.mounted) this._unmount(null).then(() => this.mac && this._state(this.mac.share, false, 'Turned off on the other computer'));
  }

  // Open: the folder in the file manager.
  open() {
    if (this.mounted) {
      if (this.mounted.path) shell.openPath(this.mounted.path);
      else shell.openExternal(this.mounted.uri.replace(/^smb:\/\/[^@]*@/, 'smb://'));
    }
  }

  _state(share, mounted, error) {
    const msg = { t: T.SMB_STATE, share, mounted };
    if (error) msg.error = error;
    this.link.send(msg);
    this.onChange();
  }

  _msg(text) { this.message = text; this.onChange(); }
  _busy(what) { this.busy = what; this.onChange(); }

  view() {
    return {
      busy: this.busy, message: this.message, sharing: !!(this.cfg.shareOn && this._creds()),
      peer: this.peerState, macShare: this.mac ? this.mac.share : '', drive: this.mounted ? this.mounted.path || this.mounted.uri : '', mountMessage: this.mountMessage,
      wifi: !this.mounted && !!this.mac && !!(this.canWifi && this.canWifi()), // through Bluetooth: Open connects it over Wi-Fi Direct
      folder: this.cfg.shareFolder || this.defaultFolder,
    };
  }
}

// `gio mount`, answering its password prompt (the user and domain are in the URI).
function gioMount(uri, password) {
  return new Promise((resolve, reject) => {
    let out = '';
    let p;
    try { p = spawn('gio', ['mount', uri], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
    const timer = setTimeout(() => { p.kill(); reject(new Error('it took too long')); }, 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'connecting network folders needs GVFS (the gio command)' : e.message)); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || /already mounted/i.test(out)) return resolve();
      const why = out.split(/\r?\n/).map((l) => l.replace(/^(Password|User|Domain)[^:]*:\s*/i, '').trim()).filter(Boolean).pop();
      reject(new Error(why || 'gio mount failed (' + code + ')'));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(password + '\n');
  });
}

// The FUSE path GVFS gives a mounted smb:// location, or '' when it isn't mounted.
async function localPath(uri) {
  try {
    const out = await run('gio', ['info', '-a', 'standard::name', uri], { timeout: 8000 });
    const m = /^local path:\s*(.+)$/m.exec(out);
    return m && fs.existsSync(m[1].trim()) ? m[1].trim() : '';
  } catch (_) { return ''; }
}

module.exports = Smb;
