# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Debug > Diagnostics > Sleep, wake and network events (shared/debuglocal.js): the System log's events of
# the last Hours that tell when this PC slept, woke and what its network did meanwhile: Kernel-Power,
# Power-Troubleshooter (the wake and its source), NDIS and the adapters' drivers, WLAN-AutoConfig, DHCP,
# Tcpip, Kernel-General (time changes; not its 16, a registry hive's access history). Oldest first, one line
# each. Text.
param([int]$Hours = 3)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'SilentlyContinue'
if ($Hours -lt 1) { $Hours = 1 } elseif ($Hours -gt 48) { $Hours = 48 }
$since = (Get-Date).AddHours(-$Hours)
$providers = 'Kernel-Power|Power-Troubleshooter|NDIS|WLAN-AutoConfig|Dhcp|Tcpip|Kernel-General|e1|Netwtw|rt640|RTL|mrvl|bcm|Intel|Realtek|Qualcomm|MediaTek|NetAdapterCx|Kernel-Boot|EventLog'
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since } |
  Where-Object { $_.ProviderName -match $providers } |
  Where-Object { -not ($_.ProviderName -match 'Kernel-General' -and $_.Id -eq 16) } |
  Sort-Object TimeCreated)
"System events since {0:yyyy-MM-dd HH:mm} ({1} found):" -f $since, $events.Count
foreach ($e in $events) {
  $msg = ($e.Message -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 2) -join ' / '
  if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) + '...' }
  "{0:yyyy-MM-dd HH:mm:ss}  {1,-5} {2} ({3}): {4}" -f $e.TimeCreated, $e.LevelDisplayName, $e.ProviderName, $e.Id, $msg
}
""
"Last wake source:"
powercfg /lastwake
