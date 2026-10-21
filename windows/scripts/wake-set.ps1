# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# wake.js, elevated: up physical adapters may wake the PC on a magic packet (-On), or not.
param([switch]$On)
Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
  try { Set-NetAdapterPowerManagement -Name $_.Name -WakeOnMagicPacket $(if ($On) { 'Enabled' } else { 'Disabled' }) -ErrorAction Stop } catch {}
  if ($On) { powercfg /deviceenablewake $_.InterfaceDescription } else { powercfg /devicedisablewake $_.InterfaceDescription }
}
