# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# identity.js: this PC's host certificate, self-signed, exported to Pfx with Pass and then taken
# out of the certificate store again.
param(
  [Parameter(Mandatory = $true)][string]$Pfx,
  [Parameter(Mandatory = $true)][string]$Pass
)
$ErrorActionPreference = 'Stop'
$c = New-SelfSignedCertificate -Subject 'CN=MacShare' -FriendlyName 'MacShare' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(10)
try {
  $pw = ConvertTo-SecureString -String $Pass -AsPlainText -Force
  Export-PfxCertificate -Cert $c -FilePath $Pfx -Password $pw | Out-Null
} finally {
  Remove-Item -Path ('Cert:\CurrentUser\My\' + $c.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
}
