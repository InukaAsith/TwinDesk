# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Debug > Diagnostics > Network adapters: power saving (shared/debuglocal.js). Each adapter, its link,
# and whether Windows may turn it off to save power: the setting that, left on, can leave Wi-Fi or
# Ethernet half-working after sleep (11-25, Ryzen9: every link dying 4 s after it connected). Text.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'SilentlyContinue'
foreach ($a in @(Get-NetAdapter | Sort-Object -Property Status, Name)) {
  "{0}  [{1}]  {2}  {3}  driver {4} ({5})" -f $a.Name, $a.Status, $a.InterfaceDescription, $a.LinkSpeed, $a.DriverVersion, $a.DriverDate
  $pm = Get-NetAdapterPowerManagement -Name $a.Name
  if ($pm) {
    "    allow the computer to turn off this device: {0}; wake on magic packet: {1}; selective suspend: {2}; device sleep on disconnect: {3}" -f $pm.AllowComputerToTurnOffDevice, $pm.WakeOnMagicPacket, $pm.SelectiveSuspend, $pm.DeviceSleepOnDisconnect
  }
  foreach ($p in @(Get-NetAdapterAdvancedProperty -Name $a.Name | Where-Object { $_.DisplayName -match 'Power|Energy|EEE|Green|Roaming|Offload|Interrupt Moderation|MIMO' })) {
    "    {0}: {1}" -f $p.DisplayName, $p.DisplayValue
  }
}
""
"Power plan:"
powercfg /getactivescheme
"Modern Standby (S0) / sleep states:"
powercfg /a
