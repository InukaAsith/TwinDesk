# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# vdd.js: the Virtual Display Driver's device (and its status) and our Extend tasks, as JSON.
$d = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains 'Root\MttVDD' } | Select-Object -First 1
$t = Get-ScheduledTask -TaskPath '\MacShare\' -TaskName 'Extend on' -ErrorAction SilentlyContinue
@{ device = [bool]$d; status = [string]$d.Status; tasks = [bool]$t } | ConvertTo-Json -Compress
