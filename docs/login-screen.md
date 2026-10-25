# Login Screen & Lock Screen KVM Architecture

TwinDesk supports controlling mouse and keyboard input at the **Login Screen**, **Lock Screen**, and **Administrator / UAC prompts** across Windows, Linux, and macOS, similar to Synergy and Barrier.

This document details the multi-OS security model, how TwinDesk injects input before and during login, and how to enable background service mode on each platform.

---

## Operating System Breakdown

### 1. Windows (`Winlogon` & UAC Secure Desktop)

#### Architecture
Windows isolates the interactive GUI session into Window Stations (`WinSta0`) with multiple desktops:
- `Default`: The standard user desktop where applications run.
- `Winlogon`: The secure desktop active during `Win + L` (Lock Screen), user logon / credential provider, and UAC elevation prompts.

Standard user-mode processes cannot inject input into `Winlogon` or hook user events there. Previously, TwinDesk's helper detected `OpenInputDesktop() == IntPtr.Zero` and sent the remote cursor back home.

#### TwinDesk Implementation
1. **Thread Desktop Synchronization (`SyncInputDesktop`)**:
   In `windows-helper/src/Native.cs`, TwinDesk queries `OpenInputDesktop()` and uses `SetThreadDesktop()` to dynamically attach the helper's injection thread to the currently active desktop (`Winlogon` or `Default`).
2. **Lock Screen Configuration (`kvm.lockScreen`)**:
   When `lockScreen` is enabled in settings (General tab › "Control on lock screen & UAC prompts"), TwinDesk maintains remote cursor control rather than aborting capture when `secureDesktop` transitions occur.
3. **Pre-Login Boot Service**:
   To control the PC before any user logs in (at cold boot), run the included PowerShell setup script as Administrator:
   ```powershell
   powershell -ExecutionPolicy Bypass -File windows\scripts\install-login-service.ps1
   ```
   This registers `macshare-winhelper.exe` as a high-privilege boot task running under `NT AUTHORITY\SYSTEM`, granting it access to `WinSta0\Winlogon` at machine startup.

---

### 2. Linux (Display Managers: GDM, SDDM, LightDM on Wayland & X11)

#### Architecture
On Linux, the login screen is presented by a Display Manager (such as GNOME's GDM, KDE's SDDM, or LightDM) before user desktop sessions exist. While standard Wayland protocols prohibit cross-process input injection:
- TwinDesk utilizes Linux kernel **`/dev/uinput`** virtual devices.
- Devices created via `uinput` (`TwinDesk virtual keyboard`, `TwinDesk virtual mouse`) are recognized by the Linux kernel and `libinput` as authentic hardware peripherals.
- Consequently, virtual input works universally in **both Wayland and X11 display managers**.

#### TwinDesk Implementation
1. **Systemd Service Unit (`twindesk-login.service`)**:
   Runs `macshare-linuxhelper` with `/dev/uinput` permissions before `display-manager.service` starts.
2. **Setup Script**:
   To install the service and configure kernel `udev` permissions:
   ```bash
   sudo bash linux/scripts/enable-login-service.sh
   ```
   This loads the `uinput` kernel module, writes `/etc/udev/rules.d/99-twindesk-uinput.rules`, and activates the systemd unit.

---

### 3. macOS (`loginwindow` & Lock Screen)

#### Architecture
Modern macOS (macOS 12 Monterey through macOS 15 Sequoia) isolates `loginwindow` under a secure system session (`_securityagent`). WindowServer deliberately drops software-generated synthetic `CGEvent` taps into password fields to prevent credential logging.

#### TwinDesk Implementation
1. **System LaunchDaemon**:
   TwinDesk includes a LaunchDaemon (`/Library/LaunchDaemons/org.twindesk.helper.plist`) to allow the helper binary to execute before user login:
   ```bash
   sudo bash mac/scripts/enable-login-daemon.sh
   ```
2. **Bluetooth HID Peripheral Emulation (Recommended for macOS)**:
   Because macOS WindowServer blocks software `CGEvent` posts inside `loginwindow`, TwinDesk's **Bluetooth HID Emulation** (`ble.c` / `Ble.cs`) serves as the hardware-level bypass:
   - When connected via Bluetooth HID, macOS kernel's `IOBluetoothFamily` and `IOHIDFamily` treat TwinDesk as a physical Bluetooth keyboard and mouse.
   - Hardware-level HID events function seamlessly at the `loginwindow`, lock screen, and even FileVault pre-boot prompts.

---

## Comparison Summary

| Capability | Windows | Linux | macOS |
| :--- | :--- | :--- | :--- |
| **Login Screen Protocol** | `WinSta0\Winlogon` | GDM / SDDM / LightDM | `loginwindow` (`_securityagent`) |
| **Injection Mechanism** | `SendInput` + `SetThreadDesktop` | `/dev/uinput` (Kernel virtual devices) | Bluetooth HID Hardware Emulation / `CGEvent` |
| **Background Service** | `schtasks` / Windows Service (`SYSTEM`) | `systemd` (`twindesk-login.service`) | LaunchDaemon (`org.twindesk.helper`) |
| **Wayland Support** | N/A | **Yes** (via kernel `/dev/uinput`) | N/A |
| **UAC / Lock Screen** | Supported (`lockScreen` switch) | Supported | Supported |
