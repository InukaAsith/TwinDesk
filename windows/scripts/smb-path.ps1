# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# smb.js: the folder the share is of, or nothing.
param([Parameter(Mandatory = $true)][string]$Share)
$s = Get-SmbShare -Name $Share -ErrorAction SilentlyContinue
if ($s) { $s.Path }
