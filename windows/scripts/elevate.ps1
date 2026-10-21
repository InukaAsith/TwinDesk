# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# ps.js scriptElevated: runs powershell.exe elevated (one UAC prompt) with ArgLine, one of the app's
# scripts and its arguments, and waits for it. Declined, Start-Process fails ("canceled by the user").
param([Parameter(Mandatory = $true)][string]$ArgLine)
$ErrorActionPreference = 'Stop'
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList $ArgLine
