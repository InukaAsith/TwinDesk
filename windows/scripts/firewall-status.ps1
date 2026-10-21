# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Portions adapted from Beamer (https://github.com/kalkman-code/beamer), Copyright (C) Kalkman Code,
# GPL-3.0 (win_app/firewall_win.py's status script). firewall.js: the inbound rules for Exe, the
# networks and their categories, and whether this account is an administrator, as JSON.
param([Parameter(Mandatory = $true)][string]$Exe)
$ErrorActionPreference = 'SilentlyContinue'
$rules = @()
$readable = $true
try {
  foreach ($f in @(Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object { $_.Program -eq $Exe })) {
    $r = $f | Get-NetFirewallRule
    if ([string]$r.Direction -ne 'Inbound') { continue }
    $pf = $r | Get-NetFirewallPortFilter
    $rules += [pscustomobject]@{ enabled = [string]$r.Enabled; action = [string]$r.Action; profile = [string]$r.Profile; protocol = [string]$pf.Protocol }
  }
} catch { $readable = $false }
# A member of Administrators (even unelevated) gets a Yes/No prompt; anyone else needs an admin's password.
# Unelevated, UAC leaves Administrators in the token as deny-only, which .Groups leaves out: the claims list it.
$admin = [bool](([Security.Principal.WindowsIdentity]::GetCurrent()).Claims | Where-Object { $_.Value -eq 'S-1-5-32-544' })
$nets = @(Get-NetConnectionProfile | ForEach-Object {
  [pscustomobject]@{ alias = $_.InterfaceAlias; index = [int]$_.InterfaceIndex; category = [string]$_.NetworkCategory; ipv4 = [string]$_.IPv4Connectivity }
})
[pscustomobject]@{ rules = @($rules); networks = $nets; readable = $readable; admin = $admin } | ConvertTo-Json -Depth 4 -Compress
