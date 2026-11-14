@echo off
rem TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
rem The Full KVM build only (docs/full-kvm.md): bin\twindesk-fullkvm.exe, the service and its setup
rem (service\*.cs), with the .NET Framework C# compiler (C# 5 only), as windows-helper\build.cmd.
rem windows-helper\build.cmd calls this when TWINDESK_EDITION=full-kvm.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set BIN=%~dp0bin
if not exist "%BIN%" mkdir "%BIN%"
"%CSC%" /nologo /optimize+ /platform:anycpu /target:exe /out:"%BIN%\twindesk-fullkvm.exe" ^
  /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Core.dll "%~dp0service\*.cs" || exit /b 1
