# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# vdd.js: the Virtual Display Driver's device (and its status) and our Extend tasks, as JSON.
$d = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains 'Root\MttVDD' } | Select-Object -First 1
$t = Get-ScheduledTask -TaskPath '\MacShare\' -TaskName 'Extend on' -ErrorAction SilentlyContinue
# The ScheduledTasks provider can fail for every path (a debloat tool's orphaned TaskCache entries,
# #116) while the task is there: then schtasks.exe, which reads the scheduler directly.
if (-not $t) {
  & "$env:SystemRoot\System32\schtasks.exe" /query /tn '\MacShare\Extend on' 2>$null | Out-Null
  $t = ($LASTEXITCODE -eq 0)
}
@{ device = [bool]$d; status = [string]$d.Status; tasks = [bool]$t } | ConvertTo-Json -Compress
