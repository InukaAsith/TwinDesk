# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds and signs the menu's sparse packages (AppxManifest.xml) into <Bin>\twindesk-shell-<arch>.msix,
# one for each twindesk-shell-<arch>.dll built. Signed with the same self-signed certificate as the
# calls' package (calls\pack.ps1 makes it, CN=TwinDesk), which the installer already trusts for app
# packages only. Run by build.cmd; needs the Windows SDK's makeappx and signtool.
param([Parameter(Mandatory = $true)][string]$Bin)
$ErrorActionPreference = 'Stop'

$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$vers = @(Get-ChildItem $kits -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '10.*' } | Sort-Object { [version]$_.Name } -Descending)
function Tool($name) {
  foreach ($v in $vers) { foreach ($a in 'x64', 'arm64', 'x86') { $p = Join-Path $v.FullName "$a\$name"; if (Test-Path $p) { return $p } } }
  throw "$name not found: install the Windows 10/11 SDK"
}
$makeappx = Tool 'makeappx.exe'
$signtool = Tool 'signtool.exe'

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq 'CN=TwinDesk' -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=TwinDesk' -CertStoreLocation Cert:\CurrentUser\My `
    -KeyUsage DigitalSignature -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={text}')
  Export-Certificate -Cert $cert -FilePath (Join-Path $Bin 'twindesk-calls.cer') | Out-Null
}

$manifest = Get-Content -Raw (Join-Path $PSScriptRoot 'AppxManifest.xml')
foreach ($arch in 'x64', 'arm64') {
  if (-not (Test-Path (Join-Path $Bin "twindesk-shell-$arch.dll"))) { continue }
  $stage = Join-Path $env:TEMP ('twindesk-shell-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $stage | Out-Null
  try {
    [IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest.Replace('@ARCH@', $arch), (New-Object Text.UTF8Encoding $false))
    Copy-Item (Join-Path $PSScriptRoot '..\..\windows\installer\icon.png') (Join-Path $stage 'logo.png')
    $msix = Join-Path $Bin "twindesk-shell-$arch.msix"
    & $makeappx pack /o /nv /d $stage /p $msix | Out-Null
    if ($LASTEXITCODE) { throw 'makeappx failed' }
  } finally { Remove-Item -Recurse -Force $stage }
  & $signtool sign /q /fd SHA256 /sha1 $cert.Thumbprint $msix
  if ($LASTEXITCODE) { throw 'signtool failed' }
  Write-Output "built $msix"
}
