@echo off
rem TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
rem Builds bin\twindesk-iosusb.exe (an iPhone's screen over USB, shared/iosusb) with the .NET
rem Framework C# compiler. AnyCPU: it loads libusb0.dll of the PC's own architecture (x64 or ARM64).
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set BIN=%~dp0..\bin
if not exist "%BIN%" mkdir "%BIN%"
"%CSC%" /nologo /optimize+ /platform:anycpu /target:exe /out:"%BIN%\twindesk-iosusb.new.exe" ^
  /r:System.Management.dll "%~dp0IosUsb.cs" || exit /b 1
del /q "%BIN%\twindesk-iosusb.old*.exe" 2>nul
set OLD=twindesk-iosusb.old.exe
if exist "%BIN%\%OLD%" set OLD=twindesk-iosusb.old-%RANDOM%.exe
if exist "%BIN%\twindesk-iosusb.exe" ren "%BIN%\twindesk-iosusb.exe" %OLD%
ren "%BIN%\twindesk-iosusb.new.exe" twindesk-iosusb.exe
