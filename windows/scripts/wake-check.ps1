# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# wake.js: up physical adapters, whether each may wake the PC (armed in powercfg) and on a magic packet.
$armed = @(powercfg /devicequery wake_armed) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$out = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | ForEach-Object {
  $m = $null
  try { $m = (Get-NetAdapterPowerManagement -Name $_.Name -ErrorAction Stop).WakeOnMagicPacket } catch {}
  [pscustomobject]@{ name = $_.Name; armed = [bool]($armed -contains $_.InterfaceDescription); magic = "$m" }
})
ConvertTo-Json -Compress -InputObject $out
