# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# smb.js, elevated: the network-only account (its password read from PwFile, which is then
# removed), hidden from the sign-in screen, allowed to change Folder, the share, and File and
# Printer Sharing's inbound rules on (Group, Private). Writes 'ok' or 'error: ...' to Result.
param(
  [Parameter(Mandatory = $true)][string]$PwFile,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Share,
  [Parameter(Mandatory = $true)][string]$Folder,
  [Parameter(Mandatory = $true)][string]$Group,
  [Parameter(Mandatory = $true)][string]$Result
)
$ErrorActionPreference = 'Stop'
try {
  $pw = ConvertTo-SecureString (Get-Content -Raw $PwFile).Trim() -AsPlainText -Force
  Remove-Item $PwFile -Force
  if (Get-LocalUser -Name $User -ErrorAction SilentlyContinue) { Set-LocalUser -Name $User -Password $pw -PasswordNeverExpires $true }
  else { New-LocalUser -Name $User -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'TwinDesk file sharing (network only)' | Out-Null }
  $k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null } # -Force on an existing key deletes and recreates it, unhiding every other account
  New-ItemProperty -Path $k -Name $User -Value 0 -PropertyType DWord -Force | Out-Null
  icacls $Folder /grant ($User + ':(OI)(CI)M') | Out-Null
  if (Get-SmbShare -Name $Share -ErrorAction SilentlyContinue) { Remove-SmbShare -Name $Share -Force }
  New-SmbShare -Name $Share -Path $Folder -ChangeAccess $User | Out-Null
  Get-NetFirewallRule -Group $Group -ErrorAction SilentlyContinue | Where-Object { [string]$_.Direction -eq 'Inbound' -and [string]$_.Profile -match 'Private|Any' } | Enable-NetFirewallRule
  Set-Content -Path $Result -Value 'ok'
} catch { Set-Content -Path $Result -Value ('error: ' + $_.Exception.Message) }
