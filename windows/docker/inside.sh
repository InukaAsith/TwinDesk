#!/bin/bash
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# In the build container (windows/docker/Dockerfile, started by build.sh, the repository at /src): what
# windows-helper/build.cmd does on Windows, then the installer (windows/installer/build.js).
#   - the helpers (one-to-one, Multi-device and, Full KVM, the agent) and the Full KVM service: Roslyn
#     with -langversion:5 against .NET Framework 4.8's references, the same sources and defines as build.cmd
#   - the input lane, tdfast.dll for x64 and arm64: cargo-xwin
#   - not here: the calls' package (pack.ps1 signs it with PowerShell), the virtual camera, the gamepad and
#     native screen capture (C++): the ones already in windows-helper/bin/ are packed as they are
# Arguments: what build.js takes (x64, arm64, portable). TWINDESK_EDITION=full-kvm: the Full KVM build.
set -euo pipefail

ROOT=/src
BIN=$ROOT/windows-helper/bin
R=/refs/net48
CSC=$(ls -d /usr/share/dotnet/sdk/*/Roslyn/bincore/csc.dll | head -1)
mkdir -p "$BIN"

# csc.exe's own defaults (its csc.rsp): what build.cmd's sources use without naming it.
STD=()
for a in Accessibility Microsoft.CSharp System.Configuration System.Configuration.Install System.Core System.Data \
  System.Data.DataSetExtensions System.Data.Linq System.Deployment System.Design System.DirectoryServices System \
  System.Drawing.Design System.Drawing System.EnterpriseServices System.Management System.Messaging \
  System.Runtime.Remoting System.Runtime.Serialization System.Runtime.Serialization.Formatters.Soap System.Security \
  System.ServiceModel System.ServiceModel.Web System.ServiceProcess System.Transactions System.Web System.Web.Extensions \
  System.Web.Services System.Windows.Forms System.Xml System.Xml.Linq; do
  [ -f "$R/$a.dll" ] && STD+=("-r:$R/$a.dll")
done
UIA=("-r:$R/UIAutomationClient.dll" "-r:$R/UIAutomationTypes.dll" "-r:$R/WindowsBase.dll")
WINRT=("-r:/refs/Windows.winmd" "-r:/refs/System.Runtime.WindowsRuntime.dll" "-r:$R/Facades/System.Runtime.dll"
  "-r:$R/Facades/System.Threading.Tasks.dll" "-r:$R/Facades/System.Runtime.InteropServices.WindowsRuntime.dll")

# csc <out.exe> <target> [defines] <sources...>
csc() {
  local out=$1 target=$2 defines=$3
  shift 3
  echo "csc: $(basename "$out")${defines:+ ($defines)}"
  dotnet "$CSC" -nologo -noconfig -nostdlib -langversion:5 -optimize+ -platform:anycpu -target:"$target" \
    ${defines:+-define:$defines} -r:"$R/mscorlib.dll" "${STD[@]}" "${UIA[@]}" "${WINRT[@]}" \
    -nowarn:1701,1702 -out:"$out.new" "$@" | grep -v ': warning ' || true
  [ -f "$out.new" ] || { echo "csc failed: $out"; exit 1; }
  mv -f "$out.new" "$out"
}

echo "== The helpers (Roslyn, C# 5)"
csc "$BIN/macshare-winhelper.exe" exe "" "$ROOT"/windows-helper/src/*.cs
csc "$BIN/macshare-winhelper-multi.exe" exe MULTI "$ROOT"/windows-helper/src/*.cs
if [ "${TWINDESK_EDITION:-}" = "full-kvm" ]; then
  csc "$BIN/macshare-winhelper-agent.exe" exe "MULTI;FULLKVM" "$ROOT"/windows-helper/src/*.cs
  mkdir -p "$ROOT/windows/fullkvm/bin"
  csc "$ROOT/windows/fullkvm/bin/twindesk-fullkvm.exe" exe "" "$ROOT"/windows/fullkvm/service/*.cs
fi

echo "== The input lane (tdfast.dll, cargo-xwin)"
if [ -n "${TWINDESK_NO_TDFAST:-}" ]; then
  echo "skipped (TWINDESK_NO_TDFAST)"
else
  for pair in x86_64-pc-windows-msvc:x64 aarch64-pc-windows-msvc:arm64; do
    target=${pair%%:*}; arch=${pair##*:}
    if cargo xwin build --release --lib --manifest-path "$ROOT/native/tdfast/Cargo.toml" --target "$target" --target-dir /tmp/tdfast-target; then
      mkdir -p "$BIN/$arch" && cp -f "/tmp/tdfast-target/$target/release/tdfast.dll" "$BIN/$arch/tdfast.dll"
    else
      echo "note: tdfast didn't build for $arch: the input lane stays in Node there"
    fi
  done
fi

echo "== The installer (electron-builder, NSIS)"
cd "$ROOT/windows"
[ -d node_modules/electron-builder ] || npm install --no-audit --no-fund
node installer/build.js "$@"

# What the container wrote in the repository is the person's, not root's.
if [ -n "${HOST_UID:-}" ]; then
  chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$BIN" "$ROOT/windows/dist" "$ROOT/windows/fullkvm/bin" "$ROOT/windows/vendor" 2>/dev/null || true
fi
echo "== Done: $(ls "$ROOT"/windows/dist/*.exe 2>/dev/null | tr '\n' ' ')"
