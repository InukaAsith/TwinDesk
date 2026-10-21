# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# vdd.js: this account's SID, and Windows' processor architecture (12 = ARM64).
[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
(Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
