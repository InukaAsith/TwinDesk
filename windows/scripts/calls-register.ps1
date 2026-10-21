# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# callaudio.js: the calls' sparse package registered for this user, its external location where
# TwinDesk is (again when its version differs, or with -Force). Prints {ok} or {error}.
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Msix,
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$out = @{}
try {
  $p = Get-AppxPackage -Name $Name
  if ($p -and ($Force -or "$($p.Version)" -ne $Version)) { $p | Remove-AppxPackage; $p = $null }
  if (-not $p) { Add-AppxPackage -Path $Msix -ExternalLocation $Root -ForceUpdateFromAnyVersion }
  $out.ok = $true
} catch { $out.error = $_.Exception.Message }
ConvertTo-Json $out -Compress
