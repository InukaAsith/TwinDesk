# Full KVM: the service (Windows, Linux)

Branch `twindesk-full-kvm-v3.1.1`. The mouse and keyboard of the mesh reach everything on a Windows or
Linux computer: UAC prompts, the lock screen, Ctrl+Alt+Del, windows run as administrator, polkit
dialogs, and (System-wide) the login screen after a restart or sign-out. Chosen on the **Full KVM** tab.

## The tab in every build

`shared/ui-fullkvm.js` is the tab on Windows and Linux in every build, with a picture of it at work at
the bottom (`FeatureArt.picture('fullkvm')`, `shared/feature-art.js`). The Full KVM build's preload
gives it `window.tdFullKvm` and the choice works. The normal build has no preload, service, agent or
helper of Full KVM (`shared/fullkvm/` and the platform's `fullkvm/` aren't in it): the tab shows the
same choice, unusable, under a card saying it's only in the Full KVM builds, with a link to them.

It's a module (Settings › General › Modules › Full KVM). Off, the page isn't loaded and the app doesn't
connect to the service (`shared/edition.js` `moduleOff`, read before the helper is made). A service that
is installed stays installed: Off / Signed in / Always is changed on the tab, before switching it off.

## Why the app alone can't

- **Windows.** The helper runs as the signed-in user. A UAC prompt, the lock screen and Ctrl+Alt+Del
  are on the secure desktop (`winsta0\Winlogon`), which no user process may open: `Native.SecureDesktop()`
  sees it and the pointer stops. Windows run as administrator refuse its injected input (UIPI). Nobody
  signed in: no TwinDesk at all.
- **Linux.** X11 lock screens take XTest input already; Wayland's helper needs `/dev/uinput` (the
  setgid copy, #144). The greeter (GDM, SDDM, LightDM) runs as its own user before anyone signs in:
  no TwinDesk there.

## The two modes

| | Off | Simple | System-wide |
|---|---|---|---|
| Lock screen, UAC, Ctrl+Alt+Del, admin windows | no | yes | yes |
| Login screen (nobody signed in) | no | no | yes |
| Pairing | per user | per user | per user, plus a machine copy |
| Installs | nothing | the service | the service and the machine node |

Both need an administrator once (UAC on Windows, pkexec on Linux), from the tab's button.

## The pieces

```
            signed in                                  nobody signed in (System-wide)
  TwinDesk app (user) ──kvm pipe──▶ service ◀──kvm pipe── machine node (unprivileged account)
     helper: clipboard, windows…      │                     mesh core headless: link, pairing,
                                      ▼                     layout, kvm (driven and driving)
                          the KVM helper, privileged,
                          on the input desktop / evdev+uinput
```

- **The KVM helper in the service.** The same helper binary, privileged:
  - Windows: `macshare-winhelper-agent.exe --agent` (the multi helper's sources built with `FULLKVM`,
    `windows-helper/src/Agent.cs`), started by the service (LocalSystem) in the console session with a
    SYSTEM token. A thread with hooks can't change desktops, so an agent belongs to the input desktop it
    started on (Default, Winlogon, Screen-saver); when that changes it exits with code 3 and the service
    starts another there, giving it the last `kvmConfig`, `armReturn` and `capture` again: the app never
    sees the switch. Ctrl+Alt+Del becomes `SendSAS` in the service (the policy
    `SoftwareSASGeneration` = 1 is set while Full KVM is on, and put back after).
  - Linux: `macshare-linuxhelper-multi` with `MACSHARE_HELPER_BACKEND=uinput`, as root: evdev capture and
    uinput injection, below every display server, so it works the same at the lock screen and greeter.
- **The kvm pipe.** JSON lines, the helper's own protocol, for the KVM commands only (`kvmConfig`,
  `screens`, `capture`, `place`, `armReturn`, `inject`, `releaseAll`, `watchRelease`, `moveTo`, `info`,
  `ping`): anything else (files, clipboard, windows) is refused, so the privileged side never reads a
  file or runs anything for its client. Who may connect:
  - Windows: `\\.\pipe\TwinDesk.kvm`, its ACL the console session's user (or LOCAL SERVICE, the machine
    node, while nobody is signed in), network logons denied; the service checks the client's image is
    the TwinDesk.exe the administrator turned it on for (`%ProgramData%\TwinDesk\fullkvm.json`,
    administrators and SYSTEM only).
  - Linux: `/run/twindesk/kvm.sock`, owned by the active seat0 user (or `twindesk` at the greeter), mode
    0600; a new owner drops the old connection.
- **The app.** With the service there, `shared/fullkvm/route.js` (wrapping `linux/helper.js`,
  `windows/helper.js`) sends the KVM commands down the pipe and takes
  the KVM events from it; everything else stays with its own helper. No service: as before.
- **The machine node (System-wide).** The mesh core without Electron's windows (`electron` stubbed:
  `app.getPath` is the machine folder), started by the service while nobody is signed in and stopped
  when someone is (their app takes over the same port). It runs as an unprivileged account (Linux
  `twindesk`, Windows LOCAL SERVICE in the `TwinDeskFullKvmNode` service), never as root/SYSTEM: the network-facing part has no
  privileges, the injecting part has no network.
  - Its identity is the user's: turning System-wide on copies the certificate, device id and the
    pairings (`identity/`, `device.json`, `paired*.json`, `pairing*.json`, the layout) to the machine
    folder (`/var/lib/twindesk`, `%ProgramData%\TwinDesk\machine`, readable by the service accounts and
    administrators only). The other devices see the same device, at the same place on the map.
  - It is `shared/fullkvm/headless.js`, the same on both (the platform's own mesh modules).
  - The person's TwinDesk gives way while seat0 isn't theirs (Linux, `linux/fullkvm/manager.js`): on X11 an
    app in a session off screen stalls on the display and can't notice, yet holds the discovery port, the
    server port and the links. A guard (sh, its own `systemd-run --user` unit) ends it after 3 s and starts
    it again when the session is back. To do on Windows: a disconnected session's TwinDesk keeps running
    and holds the ports the same way.
  - On Windows the app stages the copy in its own temp folder, with the certificate's passphrase
    unsealed (DPAPI is the user's; LOCAL SERVICE couldn't open it) and its displays
    (`fullkvm-displays.json`); `--apply` copies it and the app deletes the stage.
  - Pairing changes made later reach the machine node the next time System-wide is turned on (to do:
    copy them again on their own).

## Security

- Off by default; each mode is the person's choice, with an administrator's approval.
- The privileged process takes input events only, from a client the OS vouches for (ACL, file mode),
  and never from the network.
- Approving a UAC prompt by remote input is what this is for: anyone paired with this computer can then
  do it. The tab says so.
- The machine copy of the pairing is as sensitive as the user's: same file modes, removed when
  System-wide is turned off or TwinDesk is uninstalled.

## Steps

1. Linux service and Simple mode (testable in the Ubuntu VM): `linux/fullkvm/`, the pipe, `mesh/helper.js`.
2. The Full KVM tab (Linux, Windows): mode, status, install/remove.
3. Linux System-wide: the machine node, `twindesk` account, GDM greeter test in the VM.
4. Windows service, agent (desktop following, SendSAS), named pipe, installer hooks. Not built here:
   the user's Windows CI.

## Windows files

- `windows/fullkvm/service/Service.cs` → `windows/fullkvm/bin/twindesk-fullkvm.exe` (`build.cmd`, C# 5):
  the `TwinDeskFullKvm` service, the `TwinDeskFullKvmNode` service (`--node`), and the setup the tab runs
  (`--setup` asks for UAC and runs `--apply` elevated: `CreateService`, no PowerShell, no `sc.exe`).
  `--state` for the tab, `--stop`/`--start` for the installer around an update.
- `windows-helper/build.cmd` with `TWINDESK_EDITION=full-kvm` also builds the agent and calls
  `windows/fullkvm/build.cmd`; `windows/installer/build.js` with it names the installer
  `TwinDesk-FullKVM-Setup-…` and uses `installer-fullkvm.nsh` (stop/start the service around an
  update, `--apply off` on uninstall). No Store package for this build.
- `windows/fullkvm/manager.js`, `preload.js`: the tab's state and modes (as Linux's).
- At the login screen (nobody signed in) the first agent starts on `Default` and moves to `Winlogon`
  before it's ready: the service passes the client the first `ready` from whichever agent says it,
  and only after that keeps a new agent's `ready` to itself (replaying the settings to it).
- A dev checkout: the service runs `twindesk-fullkvm.exe` from the checkout as SYSTEM, so use it on a
  test machine only (installed, it lives under Program Files, which only administrators can change).
5. Multi-device test with the Mac and the Ubuntu VM: lock screen, polkit prompt, greeter.
