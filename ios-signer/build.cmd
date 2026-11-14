@echo off
rem TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
rem Builds the iOS signing helper for the PC app: bin\x64\twindesk-ios-signer.exe and, when Rust has
rem the target, bin\arm64\ (shared/iossign-host.js looks there). Optional: without cargo nothing is
rem built and the app leaves iPhone app signing out.
rem This build signs TwinDesk for iPhone only, which it downloads itself. The one that also installs
rem an IPA the person picks is built with TWINDESK_SIGNER_ANY_IPA set, and is left out of the signed
rem installer until its certificate's terms are known to allow it.
setlocal
where cargo >nul 2>nul || (echo note: no cargo: no iOS signing helper & exit /b 0)
set CRATE=%~dp0
set FEATURES=
if defined TWINDESK_SIGNER_ANY_IPA set FEATURES=--features any-ipa
call :arch x86_64-pc-windows-msvc x64
rustup target list --installed 2>nul | findstr /b /c:"aarch64-pc-windows-msvc" >nul && call :arch aarch64-pc-windows-msvc arm64
exit /b 0

:arch
cargo build --release --locked %FEATURES% --manifest-path "%CRATE%Cargo.toml" --target %1 || (echo note: the iOS signing helper didn't build for %2 & exit /b 0)
if not exist "%CRATE%bin\%2" mkdir "%CRATE%bin\%2"
copy /y "%CRATE%target\%1\release\twindesk-ios-signer.exe" "%CRATE%bin\%2\twindesk-ios-signer.exe" >nul
exit /b 0
