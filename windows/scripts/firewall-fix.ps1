# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# firewall.js Fix, elevated: the Public networks listed made Private, our block rules removed
# (-Blocked), TwinDesk's allow rules for Exe added again (the program, and port 47800 for PC <-> PC).
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$PublicIndexes = '',
  [switch]$Blocked
)
$ErrorActionPreference = 'Continue'
foreach ($i in @($PublicIndexes -split ',' | Where-Object { $_ -match '^\d+$' })) { Set-NetConnectionProfile -InterfaceIndex ([int]$i) -NetworkCategory Private }
if ($Blocked) {
  $b = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $Exe } | Get-NetFirewallRule | Where-Object { [string]$_.Action -eq 'Block' -and [string]$_.Direction -eq 'Inbound' })
  if ($b.Count -gt 0) { $b | Remove-NetFirewallRule }
}
# Our rules for this exe, also those an older Fix added with its path's backslashes doubled (they
# never matched the program). Other installs' rules stay.
$progs = @($Exe, $Exe.Replace('\', '\\'))
Get-NetFirewallApplicationFilter | Where-Object { $progs -contains $_.Program } | Get-NetFirewallRule | Where-Object { $_.DisplayName -like 'TwinDesk Mesh*' } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'TwinDesk Mesh' -Direction Inbound -Action Allow -Program $Exe -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'TwinDesk Mesh (TCP 47800)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47800 -Program $Exe -Profile Any | Out-Null
