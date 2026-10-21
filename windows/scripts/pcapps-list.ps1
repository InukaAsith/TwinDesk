# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# pcapps.js: the Start menu's apps (name, AppID) as JSON.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
@(Get-StartApps | Select-Object Name, AppID) | ConvertTo-Json -Compress
