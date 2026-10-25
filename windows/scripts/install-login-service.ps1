# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Enables TwinDesk at Windows Login and Lock Screen.
# Registers a scheduled background task running as NT AUTHORITY\SYSTEM at computer startup
# so that the helper attaches to WinSta0\Winlogon and injects input on the secure desktop.
param(
    [switch]$Uninstall,
    [string]$InstallDir = "C:\Program Files\TwinDesk"
)

$TaskName = "TwinDeskLoginHelper"

# Check administrator privileges
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Administrator privileges are required to configure Login / Lock Screen service. Please re-run in an elevated PowerShell."
    exit 1
}

if ($Uninstall) {
    Write-Host "Removing $TaskName..." -ForegroundColor Cyan
    schtasks /delete /tn $TaskName /f 2>$null
    Write-Host "TwinDesk login service removed successfully." -ForegroundColor Green
    exit 0
}

# Locate macshare-winhelper.exe
$HelperPath = Join-Path $InstallDir "resources\app\windows-helper\bin\macshare-winhelper.exe"
if (-not (Test-Path $HelperPath)) {
    # Check development path relative to this script
    $HelperPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "windows-helper\bin\macshare-winhelper.exe"
}

if (-not (Test-Path $HelperPath)) {
    Write-Error "Could not find macshare-winhelper.exe at $HelperPath. Please specify -InstallDir."
    exit 1
}

Write-Host "Registering $TaskName for Lock Screen / Login control..." -ForegroundColor Cyan

# Create startup task with highest privileges running under SYSTEM
$Action = "cmd.exe /c start `"`" `"$HelperPath`""
$CreateCmd = "schtasks /create /tn `"$TaskName`" /tr `"$HelperPath`" /sc onstart /ru `"NT AUTHORITY\SYSTEM`" /rl HIGHEST /f"

Invoke-Expression $CreateCmd
if ($LASTEXITCODE -eq 0) {
    Write-Host "TwinDesk login helper registered successfully!" -ForegroundColor Green
    Write-Host "It will now start at system boot under SYSTEM and attach to Winlogon on the lock screen." -ForegroundColor Green
} else {
    Write-Error "Failed to register scheduled task (Exit code $LASTEXITCODE)."
    exit $LASTEXITCODE
}
