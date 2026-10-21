# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# sshd.js, elevated: OpenSSH Server installed, automatic, running (its installer adds the rule).
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
