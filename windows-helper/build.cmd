@echo off
rem TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
rem Builds bin\macshare-winhelper.exe with the .NET Framework C# compiler (C# 5 only).
rem AnyCPU: 64-bit on x64 PCs, native on Windows 11 on ARM (it has .NET Framework 4.8.1).
rem Works while TwinDesk is running: a running .exe can be renamed, so the new build is swapped
rem in and the app picks it up the next time it starts the helper.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set BIN=%~dp0bin
rem Bluetooth LE and Wi-Fi Direct (Ble.cs, Wfd.cs) are WinRT: the Windows SDK's Windows.winmd (the one
rem .NET's WinRT bridge is built against; System32\WinMetadata's split files don't work with it).
set UM=
for /d %%d in ("%ProgramFiles(x86)%\Windows Kits\10\UnionMetadata\10.*") do if exist "%%d\Windows.winmd" set UM=%%d
if not defined UM (
  echo The Windows 10/11 SDK is needed ^(Windows Kits\10\UnionMetadata^): install it with Visual Studio Build Tools or the SDK installer.
  exit /b 1
)
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
set WINRT=/r:"%UM%\Windows.winmd" /r:"%FW%\System.Runtime.WindowsRuntime.dll" /r:"%FW%\System.Runtime.dll" ^
  /r:"%FW%\System.Threading.Tasks.dll" /r:"%FW%\System.Runtime.InteropServices.WindowsRuntime.dll"
if not exist "%BIN%" mkdir "%BIN%"
"%CSC%" /nologo /optimize+ /platform:anycpu /target:exe /out:"%BIN%\macshare-winhelper.new.exe" ^
  /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll %WINRT% "%~dp0src\*.cs" || exit /b 1
rem The previous build may still be running (old.exe): then park the current one under another name.
del /q "%BIN%\macshare-winhelper.old*.exe" 2>nul
set OLD=macshare-winhelper.old.exe
if exist "%BIN%\%OLD%" set OLD=macshare-winhelper.old-%RANDOM%.exe
if exist "%BIN%\macshare-winhelper.exe" ren "%BIN%\macshare-winhelper.exe" %OLD%
ren "%BIN%\macshare-winhelper.new.exe" macshare-winhelper.exe
rem The calls' sound on this PC (windows/callaudio.js): its own .exe with its own manifest (calls\),
rem and the signed sparse package that gives it an identity (pack.ps1). A Windows app, not a console
rem one: Windows starts it by itself on a call (phoneCallActivation), and a console app opened a terminal.
"%CSC%" /nologo /optimize+ /platform:anycpu /target:winexe /out:"%BIN%\macshare-calls.new.exe" ^
  /win32manifest:"%~dp0calls\macshare-calls.manifest" /r:System.Web.Extensions.dll %WINRT% ^
  "%~dp0calls\Calls.cs" "%~dp0src\Json.cs" || exit /b 1
del /q "%BIN%\macshare-calls.old*.exe" 2>nul
set OLD=macshare-calls.old.exe
if exist "%BIN%\%OLD%" set OLD=macshare-calls.old-%RANDOM%.exe
if exist "%BIN%\macshare-calls.exe" ren "%BIN%\macshare-calls.exe" %OLD%
ren "%BIN%\macshare-calls.new.exe" macshare-calls.exe
rem Without PowerShell 7's module path (a pwsh terminal, CI): Windows PowerShell then loads its own PKI.
set PSModulePath=
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0calls\pack.ps1" -Bin "%BIN%" || exit /b 1
