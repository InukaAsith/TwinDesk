# Full KVM: the service (Windows, Linux)

Branch `twindesk-full-kvm-v3.1.1`. The mouse and keyboard of the mesh reach everything on a Windows or
Linux computer: UAC prompts, the lock screen, Ctrl+Alt+Del, windows run as administrator, polkit
dialogs, and (System-wide) the login screen after a restart or sign-out. Chosen on the **Full KVM** tab.

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
  - Windows: `macshare-winhelper-multi.exe --agent`, started by the service (LocalSystem) in the
    console session with a SYSTEM token on `winsta0`. It follows the input desktop (Default, Winlogon,
    Screen-saver), re-attaching its hook and inject threads on every switch, as Synergy's does. Ctrl+Alt+Del
    is `SendSAS` from the service.
  - Linux: `macshare-linuxhelper-multi` with `MACSHARE_HELPER_BACKEND=uinput`, as root: evdev capture and
    uinput injection, below every display server, so it works the same at the lock screen and greeter.
- **The kvm pipe.** JSON lines, the helper's own protocol, for the KVM commands only (`kvmConfig`,
  `screens`, `capture`, `place`, `armReturn`, `inject`, `releaseAll`, `watchRelease`, `moveTo`, `info`,
  `ping`): anything else (files, clipboard, windows) is refused, so the privileged side never reads a
  file or runs anything for its client. Who may connect:
  - Windows: `\\.\pipe\TwinDesk.kvm.<session>`, its ACL the console session's user (and the machine
    node's account); the agent checks the client's image is the installed TwinDesk.
  - Linux: `/run/twindesk/kvm.sock`, owned by the active seat0 user (or `twindesk` at the greeter), mode
    0600; a new owner drops the old connection.
- **The app.** With the service there, `mesh/helper.js` sends the KVM commands down the pipe and takes
  the KVM events from it; everything else stays with its own helper. No service: as before.
- **The machine node (System-wide).** The mesh core without Electron's windows (`electron` stubbed:
  `app.getPath` is the machine folder), started by the service while nobody is signed in and stopped
  when someone is (their app takes over the same port). It runs as an unprivileged account (Linux
  `twindesk`, Windows `NT SERVICE\TwinDeskNode`), never as root/SYSTEM: the network-facing part has no
  privileges, the injecting part has no network.
  - Its identity is the user's: turning System-wide on copies the certificate, device id and the
    pairings (`identity/`, `device.json`, `paired*.json`, `pairing*.json`, the layout) to the machine
    folder (`/var/lib/twindesk`, `%ProgramData%\TwinDesk\machine`, readable by the service accounts and
    administrators only). The other devices see the same device, at the same place on the map.
  - Pairing changes in the app are copied again while System-wide is on (the app asks the service).

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
5. Multi-device test with the Mac and the Ubuntu VM: lock screen, polkit prompt, greeter.
