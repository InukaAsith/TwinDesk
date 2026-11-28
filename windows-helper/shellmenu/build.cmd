@echo off
rem TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
rem Windows 11's first-level right-click menu (menu.cpp, windows/shellmenu.js): bin\twindesk-shell-x64.dll
rem and, with Visual Studio's ARM64 tools, bin\twindesk-shell-arm64.dll (Explorer loads the one of
rem Windows' own architecture), then a sparse package for each (pack.ps1). Needs Visual Studio or its
rem Build Tools with C++; without them nothing is built and Windows 11 keeps TwinDesk under Show more options.
setlocal
set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if not exist "%VSWHERE%" goto none
set VS=
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VS=%%i
if not defined VS goto none
set SRC=%~dp0
set BIN=%~dp0..\bin
set OBJ=%~dp0..\bin\shellmenu-obj
if not exist "%BIN%" mkdir "%BIN%"
set CFLAGS=/nologo /O2 /EHsc /MT /W3 /std:c++17 /DUNICODE /D_UNICODE

call :arch x64 x64 || exit /b 1
set ARM=
if exist "%VS%\VC\Tools\MSVC" for /d %%d in ("%VS%\VC\Tools\MSVC\*") do if exist "%%d\bin\Hostx64\arm64\cl.exe" set ARM=1
if defined ARM (call :arch x64_arm64 arm64 || exit /b 1) else echo note: no ARM64 C++ tools: no twindesk-shell-arm64.dll
rmdir /s /q "%OBJ%" 2>nul
set PSModulePath=
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SRC%pack.ps1" -Bin "%BIN%" || exit /b 1
exit /b 0

:arch
setlocal
if not exist "%OBJ%\%2" mkdir "%OBJ%\%2"
call "%VS%\VC\Auxiliary\Build\vcvarsall.bat" %1 >nul || exit /b 1
rem Explorer's surrogate may hold the old one: the new one is built beside it and swapped in.
cl %CFLAGS% /LD /Fo"%OBJ%\%2\\" "%SRC%menu.cpp" /link /DEF:"%SRC%menu.def" /OUT:"%BIN%\twindesk-shell-%2.new.dll" /IMPLIB:"%OBJ%\%2\menu.lib" || exit /b 1
del /q "%BIN%\twindesk-shell-%2.old*.dll" 2>nul
if exist "%BIN%\twindesk-shell-%2.dll" ren "%BIN%\twindesk-shell-%2.dll" twindesk-shell-%2.old-%RANDOM%.dll
ren "%BIN%\twindesk-shell-%2.new.dll" twindesk-shell-%2.dll
del /q "%BIN%\twindesk-shell-%2.new.*" 2>nul
echo built twindesk-shell-%2.dll
exit /b 0

:none
echo note: no Visual Studio C++ tools: Windows 11's first-level menu isn't built (TwinDesk stays under Show more options)
exit /b 0
