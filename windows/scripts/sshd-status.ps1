# TwinDesk - Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# sshd.js: OpenSSH Server running, stopped or missing.
$s = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $s) { 'missing' } elseif ($s.Status -eq 'Running') { 'running' } else { 'stopped' }
