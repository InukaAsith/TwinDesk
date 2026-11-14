# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# When the Store MSIX won't pack (makeappx: "The package manifest is not valid"), which part of
# installer/store-manifest.xml it is: packs electron-builder's staged package again, each time
# without one part of the manifest, and says which pass. Run by store-windows.yml on failure.
param([string]$Dist = (Join-Path $PSScriptRoot '..\dist'))
$ErrorActionPreference = 'Continue'
$stage = Get-ChildItem $Dist -Directory -Filter '__appx-*' | Select-Object -First 1
if (-not $stage) { Write-Output 'no __appx-* folder left to look at'; exit 0 }
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$makeappx = Get-ChildItem $kits -Recurse -Filter makeappx.exe | Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
$manifest = Join-Path $stage.FullName 'AppxManifest.xml'
$original = Get-Content $manifest -Raw
Write-Output "makeappx: $($makeappx.FullName)"
Write-Output '--- the manifest ---'
Write-Output $original

function Try-Pack($label, $xml) {
  Set-Content -Path $manifest -Value $xml -Encoding UTF8
  $out = Join-Path $env:TEMP ('diag-' + [guid]::NewGuid().ToString('N') + '.msix')
  $log = & $makeappx.FullName pack /o /f (Join-Path $stage.FullName 'mapping.txt') /p $out 2>&1
  $ok = $LASTEXITCODE -eq 0
  Remove-Item $out -ErrorAction SilentlyContinue
  Write-Output ("{0,-28} {1}" -f $label, $(if ($ok) { 'PASSES' } else { 'fails' }))
  if (-not $ok -and $label -eq 'as built') { $log | Where-Object { $_ -match 'error|line|column' } | ForEach-Object { Write-Output "    $_" } }
}

$parts = [ordered]@{
  'no phoneCallActivation' = '\s*<uap13:Extension[^>]*/>'
  'no firewall rules'      = '(?s)\s*<desktop2:Extension Category="windows.firewallRules">.*?</desktop2:Extension>'
  'no alias'               = '(?s)\s*<uap3:Extension Category="windows.appExecutionAlias".*?</uap3:Extension>'
  'no protocol'            = '(?s)\s*<uap3:Extension Category="windows.protocol">.*?</uap3:Extension>'
  'no desktop6'            = '(?s)\s*<desktop6:[A-Za-z]+>disabled</desktop6:[A-Za-z]+>'
  'no phone capabilities'  = '(?s)\s*<(uap:Capability Name="phoneCall"|rescap:Capability Name="phone[A-Za-z]+")/>'
  'no bluetooth'           = '\s*<DeviceCapability Name="bluetooth"/>'
}
Try-Pack 'as built' $original
foreach ($k in $parts.Keys) { Try-Pack $k ([regex]::Replace($original, $parts[$k], '')) }
$all = $original
foreach ($k in $parts.Keys) { $all = [regex]::Replace($all, $parts[$k], '') }
Try-Pack 'none of them' $all
Set-Content -Path $manifest -Value $original -Encoding UTF8
