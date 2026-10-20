// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Builds the Windows installer (npm run dist): the helper, a staging folder with the same layout
// as the repo (windows/, shared/protocol.js, windows-helper/bin/), then electron-builder → NSIS.
// For a phone as the peer it also carries adb (downloaded, scripts/fetch-adb.js) and the
// scrcpy server (mac/vendor/scrcpy-server) in windows/vendor/.
// The layout is kept so '../shared/protocol.js' and the helper path work unchanged; no asar, so
// the helper .exe and the .ps1 scripts are real files Windows can run.
// `node installer/build.js [x64] [arm64]`: one installer per architecture, x64 when none is named.
// The x64 one keeps the name every release has used; arm64 gets -arm64 (the update check picks by
// that). One AnyCPU helper .exe serves both (build.cmd).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const builder = require('electron-builder');
const { fetchAdb } = require('../scripts/fetch-adb');

const WIN = path.join(__dirname, '..');
const ROOT = path.join(WIN, '..');
const STAGE = path.join(WIN, 'dist', 'stage');
const pkg = require(path.join(WIN, 'package.json'));
const electronVersion = require(path.join(WIN, 'node_modules', 'electron', 'package.json')).version;

const SKIP = new Set(['node_modules', 'dist', 'installer', 'test', 'package-lock.json']); // tests stay out of the package
const ARCHS = process.argv.slice(2).length ? process.argv.slice(2) : ['x64'];
for (const a of ARCHS) if (a !== 'x64' && a !== 'arm64') throw new Error('Unknown architecture ' + a + ' (x64 or arm64)');

function copy(from, to, filter = () => true) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (filter(name)) copy(path.join(from, name), path.join(to, name));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// Runtime dependencies (and theirs) from windows/node_modules.
function copyDeps(names, seen = new Set()) {
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = path.join(WIN, 'node_modules', name);
    copy(dir, path.join(STAGE, 'node_modules', name));
    copyDeps(Object.keys(require(path.join(dir, 'package.json')).dependencies || {}), seen);
  }
}

async function main() {
  // The helper needs Windows' C# compiler; elsewhere (a Mac) the installer reuses the .exe already
  // in windows-helper/bin/, e.g. one taken from the last release.
  if (process.platform === 'win32') {
    console.log('Building the helper…');
    execFileSync('cmd.exe', ['/c', path.join(ROOT, 'windows-helper', 'build.cmd')], { stdio: 'inherit' });
  } else if (!fs.existsSync(path.join(ROOT, 'windows-helper', 'bin', 'macshare-winhelper.exe'))) {
    throw new Error('Not on Windows: put a built macshare-winhelper.exe in windows-helper/bin/ first');
  } else {
    console.log('Not on Windows: using the helper already in windows-helper/bin/');
  }

  console.log('Staging…');
  fs.rmSync(STAGE, { recursive: true, force: true });
  copy(WIN, path.join(STAGE, 'windows'), (name) => !SKIP.has(name));
  // Every shared module the app requires (a list kept by hand once left the installer without a new one).
  for (const f of fs.readdirSync(path.join(ROOT, 'shared'))) if (f.endsWith('.js')) copy(path.join(ROOT, 'shared', f), path.join(STAGE, 'shared', f));
  copy(path.join(ROOT, 'windows-helper', 'bin', 'macshare-winhelper.exe'),
    path.join(STAGE, 'windows-helper', 'bin', 'macshare-winhelper.exe'));
  // A phone: its screen, apps and input go through adb and scrcpy-server (phone-bridge.js).
  if (!fs.existsSync(path.join(WIN, 'vendor', 'scrcpy-server'))) {
    copy(path.join(ROOT, 'mac', 'vendor', 'scrcpy-server'), path.join(STAGE, 'windows', 'vendor', 'scrcpy-server'));
  }
  await fetchAdb(path.join(STAGE, 'windows', 'vendor', 'adb'));
  // TwinDesk for Android with notification access, which this PC installs over wireless debugging.
  const dist = path.join(ROOT, 'android', 'dist');
  const full = fs.existsSync(dist) && fs.readdirSync(dist).filter((n) => /-full\.apk$/.test(n)).sort().pop();
  if (full) copy(path.join(dist, full), path.join(STAGE, 'windows', 'vendor', 'twindesk-android-full.apk'));
  else console.log('note: no android/dist/*-full.apk — the installer won’t offer the full Android build');
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES', 'README.md', 'licenses']) {
    if (fs.existsSync(path.join(ROOT, f))) copy(path.join(ROOT, f), path.join(STAGE, f));
  }
  copyDeps(Object.keys(pkg.dependencies || {}));
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
    name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description,
    license: pkg.license, author: 'inukaasith', main: 'windows/main.js', dependencies: pkg.dependencies,
  }, null, 2));

  for (const arch of ARCHS) await pack(arch);
}

async function pack(arch) {
  const name = 'TwinDesk-Setup-' + pkg.version + (arch === 'x64' ? '' : '-' + arch) + '.exe';
  console.log('Packaging ' + arch + '…');
  await builder.build({
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch[arch]),
    projectDir: WIN,
    config: {
      appId: 'org.macshare.windows',
      productName: 'TwinDesk',
      copyright: 'Copyright (C) 2026 inukaasith',
      electronVersion,
      directories: { app: STAGE, output: path.join(WIN, 'dist') },
      asar: false,
      npmRebuild: false,
      win: { icon: path.join(__dirname, 'icon.ico'), executableName: 'TwinDesk' },
      nsis: {
        oneClick: false,
        perMachine: true,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        installerIcon: path.join(__dirname, 'icon.ico'),
        uninstallerIcon: path.join(__dirname, 'icon.ico'),
        license: path.join(ROOT, 'LICENSE'),
        include: path.join(__dirname, 'installer.nsh'),
        shortcutName: 'TwinDesk',
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        runAfterFinish: true,
        artifactName: name,
      },
    },
  });
  console.log('Done: ' + path.join(WIN, 'dist', name));
}

main().catch((e) => { console.error(e); process.exit(1); });
