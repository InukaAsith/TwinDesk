// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Builds the Linux packages (`npm run dist`): the helper, a staging folder with the same
// layout as the repo (linux/, shared/, linux-helper/bin/), then electron-builder → AppImage and
// .deb (x64). Same approach as windows/installer/build.js: the layout is kept so
// '../shared/protocol.js' and the helper path work unchanged; no asar, so the helper is a real file.
// Run it on Linux (or in WSL) with the X11 dev packages installed. For a phone as the peer it also
// carries adb (downloaded, scripts/fetch-adb.js) and the scrcpy server (mac/vendor/scrcpy-server)
// in linux/vendor/.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const builder = require('electron-builder');
const { fetchAdb } = require('../scripts/fetch-adb');

const LIN = path.join(__dirname, '..');
const ROOT = path.join(LIN, '..');
const STAGE = path.join(LIN, 'dist', 'stage');
const pkg = require(path.join(LIN, 'package.json'));
const electronVersion = require(path.join(LIN, 'node_modules', 'electron', 'package.json')).version;

const SKIP = new Set(['node_modules', 'dist', 'installer', 'test', 'package-lock.json']); // tests stay out of the package

function copy(from, to, filter = () => true) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (filter(name)) copy(path.join(from, name), path.join(to, name));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, st.mode);
  }
}

function copyDeps(names, seen = new Set()) {
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = path.join(LIN, 'node_modules', name);
    copy(dir, path.join(STAGE, 'node_modules', name));
    copyDeps(Object.keys(require(path.join(dir, 'package.json')).dependencies || {}), seen);
  }
}

async function main() {
  console.log('Building the helper…');
  execFileSync('sh', [path.join(ROOT, 'linux-helper', 'build.sh')], { stdio: 'inherit' });

  console.log('Staging…');
  fs.rmSync(STAGE, { recursive: true, force: true });
  copy(LIN, path.join(STAGE, 'linux'), (name) => !SKIP.has(name));
  // Every shared module (a list missed new ones: the app then failed on its first require), and the
  // pages' styles and the call window (phonehub.css, callpop.html).
  for (const name of fs.readdirSync(path.join(ROOT, 'shared'))) {
    if (/\.(js|css|html)$/.test(name)) copy(path.join(ROOT, 'shared', name), path.join(STAGE, 'shared', name));
  }
  copy(path.join(ROOT, 'linux-helper', 'bin', 'macshare-linuxhelper'), path.join(STAGE, 'linux-helper', 'bin', 'macshare-linuxhelper'));
  copy(path.join(ROOT, 'linux-helper', 'bin', 'twindesk-wifiap'), path.join(STAGE, 'linux-helper', 'bin', 'twindesk-wifiap'));
  // A phone: its screen, apps and input go through adb and scrcpy-server (phone-bridge.js).
  if (!fs.existsSync(path.join(LIN, 'vendor', 'scrcpy-server'))) {
    copy(path.join(ROOT, 'mac', 'vendor', 'scrcpy-server'), path.join(STAGE, 'linux', 'vendor', 'scrcpy-server'));
  }
  await fetchAdb(path.join(STAGE, 'linux', 'vendor', 'adb'));
  // The Android app with notification access, installed over the phone's through wireless debugging
  // (phone-bridge.js installFull).
  const dist = path.join(ROOT, 'android', 'dist');
  const full = fs.existsSync(dist) && fs.readdirSync(dist).filter((n) => /-full\.apk$/.test(n)).sort().pop();
  if (full) copy(path.join(dist, full), path.join(STAGE, 'linux', 'vendor', 'twindesk-android-full.apk'));
  else console.log('note: no android/dist/*-full.apk — the package won’t offer the full Android build');
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES', 'README.md', 'licenses']) {
    if (fs.existsSync(path.join(ROOT, f))) copy(path.join(ROOT, f), path.join(STAGE, f));
  }
  copyDeps(Object.keys(pkg.dependencies || {}));
  // Extend on X11 (vdd.js): the connector helper and its polkit action, at their system paths in
  // the .deb (fpm's source=destination); the AppImage's Install writes the same files.
  const system = path.join(LIN, 'dist', 'system');
  fs.rmSync(system, { recursive: true, force: true });
  fs.mkdirSync(system, { recursive: true });
  const systemFiles = require('../vdd').FILES.map((f) => {
    const file = path.join(system, path.basename(f.path));
    fs.writeFileSync(file, f.text);
    fs.chmodSync(file, f.mode);
    return file + '=' + f.path;
  });
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
    name: 'twindesk', productName: pkg.productName, version: pkg.version, description: pkg.description,
    license: pkg.license, author: { name: 'inukaasith', email: 'inukaasith@users.noreply.github.com' },
    homepage: 'https://github.com/InukaAsith/TwinDesk', main: 'linux/main.js', dependencies: pkg.dependencies,
  }, null, 2));

  console.log('Packaging…');
  await builder.build({
    targets: builder.Platform.LINUX.createTarget(['AppImage', 'deb'], builder.Arch.x64),
    projectDir: LIN,
    config: {
      appId: 'org.macshare.linux',
      productName: 'TwinDesk',
      copyright: 'Copyright (C) 2026 inukaasith',
      electronVersion,
      directories: { app: STAGE, output: path.join(LIN, 'dist') },
      asar: false,
      npmRebuild: false,
      linux: {
        icon: path.join(LIN, 'assets', 'icon.png'),
        executableName: 'twindesk',
        category: 'Utility',
        synopsis: 'Share mouse, keyboard, clipboard, files and screens with your other computer',
        maintainer: 'inukaasith',
        desktop: { entry: { Name: 'TwinDesk', StartupWMClass: 'TwinDesk', Keywords: 'KVM;mouse;keyboard;clipboard;screen;share;' } },
        artifactName: 'TwinDesk-${version}-${arch}.${ext}',
      },
      deb: {
        // Electron's own needs plus what TwinDesk calls: openssl (host certificate), pactl (sound),
        // dbus-monitor (notifications), pkexec (firewall / input access fixes), GIO (the helper's
        // Bluetooth through BlueZ). Bluetooth and the Wi-Fi it moves to (NetworkManager) are for
        // devices not on this network: recommended, not needed.
        depends: ['libgtk-3-0 | libgtk-3-0t64', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils',
          'libatspi2.0-0 | libatspi2.0-0t64', 'libuuid1', 'libsecret-1-0', 'libxi6', 'libxrandr2', 'libxfixes3',
          'openssl', 'dbus', 'pulseaudio-utils | pipewire-pulse', 'policykit-1 | pkexec', 'libglib2.0-0 | libglib2.0-0t64'],
        recommends: ['bluez', 'network-manager'],
        priority: 'optional',
        fpm: systemFiles,
      },
    },
  });
  console.log('Done: ' + path.join(LIN, 'dist'));
}

main().catch((e) => { console.error(e); process.exit(1); });
