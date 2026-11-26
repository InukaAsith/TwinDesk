# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# The Windows installer, built on Linux (windows/docker/build.sh; docs/build-windows-docker.md).
# electron-builder's own Wine image packs the installer (NSIS, rcedit under Wine). The C# helper and the
# Full KVM service are compiled by Roslyn (the .NET SDK's csc, run natively) against .NET Framework 4.8's
# reference assemblies with -langversion:5, as Windows' csc.exe does: .NET Framework itself doesn't
# install under this Wine. The input lane (native/tdfast) builds with cargo-xwin. The C++ parts (screen
# capture, virtual camera, gamepad, the calls' package) aren't built here: the ones in windows-helper/bin/
# go into the installer as they are.
FROM electronuserland/builder:wine

ENV DEBIAN_FRONTEND=noninteractive \
    WINEDEBUG=-all \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    XWIN_ACCEPT_LICENSE=1 \
    PATH=/root/.cargo/bin:/usr/share/dotnet:$PATH

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends curl ca-certificates unzip p7zip-full cabextract clang lld llvm \
 && rm -rf /var/lib/apt/lists/*

# Roslyn: the .NET SDK (its csc.dll runs on Linux).
RUN curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
 && rm /tmp/dotnet-install.sh \
 && dotnet --version

# What the C# compiles against, in /refs:
#   net48/     .NET Framework 4.8's reference assemblies (Microsoft's NuGet package), Facades too
#   Windows.winmd                    the Windows SDK's union metadata (WinRT: Bluetooth LE, Wi-Fi Direct)
#   System.Runtime.WindowsRuntime.dll  .NET Framework's own (not in the reference pack): taken from the
#                                    .NET Framework 4.8 offline installer, so the helper references 4.0.0.0
#                                    as the Windows-built one does
RUN mkdir -p /refs /tmp/r && cd /tmp/r \
 && curl -sSL -o net48.nupkg https://api.nuget.org/v3-flatcontainer/microsoft.netframework.referenceassemblies.net48/1.0.3/microsoft.netframework.referenceassemblies.net48.1.0.3.nupkg \
 && unzip -q net48.nupkg 'build/.NETFramework/v4.8/*' -d net48 \
 && mv net48/build/.NETFramework/v4.8 /refs/net48 \
 && curl -sSL -o sdkcpp.nupkg https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp/10.0.26100.1742/microsoft.windows.sdk.cpp.10.0.26100.1742.nupkg \
 && unzip -q -j sdkcpp.nupkg 'c/UnionMetadata/10.0.26100.0/Windows.winmd' -d /refs \
 && curl -sSL -o ndp48.exe 'https://go.microsoft.com/fwlink/?linkid=2088631' \
 && 7z x -y ndp48.exe x64-Windows8.1-KB4486105-x64.cab >/dev/null \
 && mkdir kb && cabextract -q -d kb -F '*msil_system.runtime.windowsruntime_b77a5c561934e089*' x64-Windows8.1-KB4486105-x64.cab \
 && cp kb/msil_system.runtime.windowsruntime_b77a5c561934e089_*/system.runtime.windowsruntime.dll /refs/System.Runtime.WindowsRuntime.dll \
 && cd / && rm -rf /tmp/r \
 && ls -la /refs

# The input lane's Rust, for Windows on x64 and arm64 (cargo-xwin fetches Microsoft's CRT and SDK
# libraries, under their license: XWIN_ACCEPT_LICENSE).
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
 && rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc \
 && curl -sSL https://github.com/rust-cross/cargo-xwin/releases/download/v0.24.2/cargo-xwin-v0.24.2.x86_64-unknown-linux-musl.tar.gz | tar xz -C /root/.cargo/bin \
 && cargo xwin --version

WORKDIR /src
