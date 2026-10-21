# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# smb.js, elevated: the share and its account removed.
param(
  [Parameter(Mandatory = $true)][string]$Share,
  [Parameter(Mandatory = $true)][string]$User
)
if (Get-SmbShare -Name $Share -ErrorAction SilentlyContinue) { Remove-SmbShare -Name $Share -Force }
Remove-LocalUser -Name $User -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList' -Name $User -ErrorAction SilentlyContinue
