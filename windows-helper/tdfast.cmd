@echo off
rem TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
rem Builds the input lane (native/tdfast, docs/protocol.md) for the helper: bin\x64\tdfast.dll and,
rem when Rust has the target, bin\arm64\tdfast.dll (Lane.cs loads the one of the helper's own
rem architecture). Optional: without cargo, or with TWINDESK_NO_TDFAST set, nothing is built and
rem Node keeps its own lane (shared/inputlane.js), which speaks the same wire.
setlocal
if defined TWINDESK_NO_TDFAST exit /b 0
where cargo >nul 2>nul || (echo note: no cargo: no tdfast.dll, the input lane stays in Node & exit /b 0)
set CRATE=%~dp0..\native\tdfast
set BIN=%~dp0bin
call :arch x86_64-pc-windows-msvc x64
rustup target list --installed 2>nul | findstr /b /c:"aarch64-pc-windows-msvc" >nul && call :arch aarch64-pc-windows-msvc arm64
if errorlevel 1 echo note: no aarch64-pc-windows-msvc target: no arm64 tdfast.dll ^(rustup target add aarch64-pc-windows-msvc^)
exit /b 0

:arch
cargo build --release --lib --manifest-path "%CRATE%\Cargo.toml" --target %1 || (echo note: tdfast didn't build for %2 & exit /b 0)
if not exist "%BIN%\%2" mkdir "%BIN%\%2"
copy /y "%CRATE%\target\%1\release\tdfast.dll" "%BIN%\%2\tdfast.dll" >nul || echo note: tdfast.dll for %2 is in use: the old one stays
exit /b 0
