# Building the Windows installer on Linux (Docker)

`windows/docker/build.sh` builds the same installer `npm run dist` builds on Windows, in a Linux
container:

```sh
windows/docker/build.sh                 # TwinDesk-Setup, x64
windows/docker/build.sh full-kvm x64    # TwinDesk-FullKVM-Setup, x64
windows/docker/build.sh x64 arm64       # both architectures
windows/docker/build.sh portable        # TwinDesk Portable
```

The installers land in `windows/dist/`. The first run builds the image (`twindesk-winbuild`): a few
GB of downloads and about ten minutes. Later runs take a minute or two. The downloads of each build
(Electron for Windows, NSIS, Microsoft's CRT for cargo-xwin, Cargo's registry) are kept in the
Docker volumes `twindesk-winbuild-cache` and `twindesk-winbuild-cargo`.

## How each part is built

| Part | On Windows (`windows-helper/build.cmd`) | Here (`windows/docker/inside.sh`) |
|---|---|---|
| The helpers (one-to-one, Multi-device, the Full KVM agent) and the Full KVM service | .NET Framework's `csc.exe`, C# 5 | Roslyn (the .NET SDK's `csc`, run on Linux) with `-langversion:5`, the same sources and defines |
| Their references | .NET Framework's own folder, the Windows SDK's `Windows.winmd` | .NET Framework 4.8's reference assemblies (Microsoft's NuGet package), `Windows.winmd` from the Windows SDK's NuGet package, `System.Runtime.WindowsRuntime.dll` taken from the .NET Framework 4.8 offline installer |
| The input lane (`tdfast.dll`, x64 and arm64) | cargo, MSVC | cargo-xwin |
| The installer | electron-builder, NSIS | the same, in electron-builder's Wine image |
| The calls' signed package, the virtual camera, the gamepad, native screen capture | PowerShell, Visual Studio's C++ | not built: the ones in `windows-helper/bin/` are packed as they are, and missing ones are left out with a note, as on a Windows machine without those tools |

.NET Framework itself doesn't install under this Wine (its installer stops), so the C# is compiled by
Roslyn against the reference assemblies. The result references the same assemblies, at the same
versions, as the Windows-built helper does (mscorlib 4.0.0.0, `Windows` as WinRT,
System.Runtime.WindowsRuntime 4.0.0.0).

## Not here

- Signing: the installer is unsigned, so Windows warns when it's opened (WIN_CSC_LINK as in CI if
  needed).
- The PowerShell scripts' parse check (CI's "Check the PowerShell scripts"): they're packed but not
  parsed here.
