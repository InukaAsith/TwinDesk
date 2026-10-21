# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# sshd.js, elevated: in administrators_authorized_keys (Path), the lines ending with Marker taken
# out and, with KeyFile, its line added; only Administrators and SYSTEM may then read the file.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Marker,
  [string]$KeyFile = ''
)
$keep = @()
if (Test-Path $Path) { $keep = @(Get-Content $Path | Where-Object { -not $_.EndsWith($Marker) }) }
elseif (-not $KeyFile) { exit 0 }
if ($KeyFile) { $keep += (Get-Content -Raw $KeyFile).Trim() }
Set-Content -Path $Path -Value $keep -Encoding ascii
if ($KeyFile) { icacls $Path /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null }
