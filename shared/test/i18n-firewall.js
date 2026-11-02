// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const I18n = require('../i18n');
const { interpret } = require('../../windows/firewall');
const alias = '以太网 中文 $& {name} <tag>';

// Exercise the shipped read-only script with deterministic network data, never real firewall rules.
if (process.platform === 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-firewall-encoding-'));
  try {
    const harness = path.join(dir, 'status-test.ps1');
    fs.writeFileSync(harness, '\ufeff' + `param([string]$StatusScript, [string]$TargetExe)
function Get-NetFirewallApplicationFilter { @() }
function Get-NetConnectionProfile {
  [pscustomobject]@{ InterfaceAlias = '${alias}'; InterfaceIndex = 9; NetworkCategory = 'Public'; IPv4Connectivity = 'Internet' }
}
& $StatusScript -Exe $TargetExe
`, 'utf8');
    const env = { ...process.env }; delete env.PSModulePath;
    const raw = execFileSync(require('../../windows/ps').PS, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
      '-StatusScript', path.resolve(__dirname, '../../windows/scripts/firewall-status.ps1'),
      '-TargetExe', process.execPath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
    assert.strictEqual(JSON.parse(raw).networks[0].alias, alias, 'PowerShell status JSON must preserve Chinese names as UTF-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const fw = interpret({ rules: [], networks: [{ alias, index: 9, category: 'Public', ipv4: 'Internet' }] });
assert.strictEqual(fw.ok, false);
assert.strictEqual(fw.publicNets[0].alias, alias);
for (const locale of ['en', 'zh-CN']) {
  const window = { MacShareProtocol: require('../protocol') };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../windows/ui-kit.js'), 'utf8'), {
    window, I18n: I18n.create(locale),
  });
  window.UI.state = { peer: { name: 'Mac $& {me}', os: 'mac' } };
  assert.strictEqual(window.UI.firewallHint(fw), locale === 'en'
    ? `The network "${alias}" is Public, so Windows blocks Mac $& {me}’s broadcasts.`
    : `网络“${alias}”被设为“公用”，因此 Windows 会阻止 Mac $& {me} 的广播。`);
  assert.strictEqual(window.UI.firewallHint({ message: 'No network connection.' }), locale === 'en' ? 'No network connection.' : '未连接网络。');
  assert.strictEqual(window.UI.firewallHint({ error: true, message: 'Native diagnostic $& {me}' }), 'Native diagnostic $& {me}');
}
console.log('i18n-firewall: UTF-8 status output and translated hints preserve literal network/device names');
