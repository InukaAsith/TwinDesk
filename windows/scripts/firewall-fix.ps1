# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# firewall.js Fix, elevated: our block rules removed (-Blocked), TwinDesk's allow rule for Exe added
# again, Private profile only. A Public network is the person's call to mark Private (the app's
# message says so): changing the category here would also open discovery and file sharing system-wide.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$PublicIndexes = '',
  [switch]$Blocked
)
$ErrorActionPreference = 'Continue'
if ($Blocked) {
  $b = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $Exe } | Get-NetFirewallRule | Where-Object { [string]$_.Action -eq 'Block' -and [string]$_.Direction -eq 'Inbound' })
  if ($b.Count -gt 0) { $b | Remove-NetFirewallRule }
}
netsh advfirewall firewall delete rule name="MacShare" | Out-Null
netsh advfirewall firewall delete rule name="MacShare (TCP 47800)" | Out-Null
# Our rules for this exe, also those an older Fix added with its path's backslashes doubled (they
# never matched the program). Other installs' rules stay.
$progs = @($Exe, $Exe.Replace('\', '\\'))
Get-NetFirewallApplicationFilter | Where-Object { $progs -contains $_.Program } | Get-NetFirewallRule | Where-Object { $_.DisplayName -like 'TwinDesk*' } | Remove-NetFirewallRule
netsh advfirewall firewall delete rule name="TwinDesk (TCP 47800)" | Out-Null
New-NetFirewallRule -DisplayName 'TwinDesk' -Direction Inbound -Action Allow -Program $Exe -Profile Private | Out-Null
