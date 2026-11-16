@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto none
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%i"
if not defined VS goto none
set "SRC=%~dp0"
set "BIN=%~dp0..\bin"
call :arch x64 x64 || exit /b 1
if exist "%VS%\VC\Tools\MSVC" for /d %%d in ("%VS%\VC\Tools\MSVC\*") do if exist "%%d\bin\Hostx64\arm64\cl.exe" set ARM=1
if defined ARM call :arch x64_arm64 arm64 || exit /b 1
exit /b 0
:arch
setlocal
call "%VS%\VC\Auxiliary\Build\vcvarsall.bat" %1 >nul || exit /b 1
if not exist "%BIN%\capture-obj\%2" mkdir "%BIN%\capture-obj\%2"
cl /nologo /O2 /EHsc /MT /W3 /std:c++17 /DUNICODE /D_UNICODE /Fo"%BIN%\capture-obj\%2\\" "%SRC%screen.cpp" /link /OUT:"%BIN%\twindesk-capture-%2.exe" d3d11.lib dxgi.lib windowsapp.lib user32.lib gdi32.lib || exit /b 1
exit /b 0
:none
echo note: no C++ tools: native screen capture is unavailable
exit /b 0
