# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds and signs the calls' sparse package (AppxManifest.xml) into <Bin>\twindesk-mesh-calls.msix, with
# its certificate's public half beside it (twindesk-mesh-calls.cer), which the installer trusts for app
# packages only (LocalMachine\TrustedPeople). The certificate is self-signed, made once on the PC
# that builds (CN=TwinDesk Mesh, as the manifests' publisher), its private key kept in that user's store.
# Run by build.cmd; needs the Windows SDK's makeappx and signtool.
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

$stage = Join-Path $env:TEMP ('twindesk-mesh-calls-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $stage | Out-Null
try {
  Copy-Item (Join-Path $PSScriptRoot 'AppxManifest.xml') $stage
  Copy-Item (Join-Path $PSScriptRoot '..\..\windows\installer\icon.png') (Join-Path $stage 'logo.png')
  $msix = Join-Path $Bin 'twindesk-mesh-calls.msix'
  & $makeappx pack /o /nv /d $stage /p $msix | Out-Null
  if ($LASTEXITCODE) { throw 'makeappx failed' }
} finally { Remove-Item -Recurse -Force $stage }

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq 'CN=TwinDesk Mesh' -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=TwinDesk Mesh' -CertStoreLocation Cert:\CurrentUser\My `
    -KeyUsage DigitalSignature -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={text}')
}
Export-Certificate -Cert $cert -FilePath (Join-Path $Bin 'twindesk-mesh-calls.cer') | Out-Null
& $signtool sign /q /fd SHA256 /sha1 $cert.Thumbprint $msix
if ($LASTEXITCODE) { throw 'signtool failed' }
Write-Output "built $msix"
