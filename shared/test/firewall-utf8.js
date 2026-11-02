// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Read-only script with mocked network data.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
if (process.platform !== 'win32') {
  console.log('firewall-utf8: Windows PowerShell check requires Windows');
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-firewall-utf8-'));
  const alias = '以太网 中文 $& {name} <tag>';
  try {
    const harness = path.join(temp, 'status.ps1');
    fs.writeFileSync(harness, '\ufeff' + `param([string]$StatusScript, [string]$TargetExe)
[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936)
function Get-NetFirewallApplicationFilter { @() }
function Get-NetConnectionProfile {
  [pscustomobject]@{ InterfaceAlias = '${alias}'; InterfaceIndex = 9; NetworkCategory = 'Public'; IPv4Connectivity = 'Internet' }
}
& $StatusScript -Exe $TargetExe
`);
    const env = { ...process.env }; delete env.PSModulePath;
    const raw = execFileSync(require('../../windows/ps').PS, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
      '-StatusScript', path.resolve(__dirname, '../../windows/scripts/firewall-status.ps1'),
      '-TargetExe', process.execPath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
    assert.strictEqual(JSON.parse(raw).networks[0].alias, alias, 'status JSON remains UTF-8 even with a legacy console encoding');
    console.log('firewall-utf8: production status script preserves Chinese names without changing network settings');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
