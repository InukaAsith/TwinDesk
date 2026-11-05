# TwinDesk on NixOS & Nix

TwinDesk provides first-class support for NixOS and Nix via `flake.nix`.

---

## 🚀 Quick Run with Nix Flakes

You can run TwinDesk directly without installing it system-wide:

```sh
nix run github:InukaAsith/TwinDesk
# Or from a local clone:
nix run .
```

To enter a development environment with all required C libraries, Node.js, Electron, and Python GStreamer typelibs:

```sh
nix develop
```

---

## ❄️ NixOS System Configuration

Add TwinDesk to your system flake inputs and enable the NixOS module:

### `flake.nix`
```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    twindesk.url = "github:InukaAsith/TwinDesk"; # or local checkout
  };

  outputs = { self, nixpkgs, twindesk, ... }: {
    nixosConfigurations.myhostname = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        twindesk.nixosModules.default
        {
          # Enable TwinDesk
          programs.twindesk = {
            enable = true; # the helper alone gets input access (a setgid wrapper); no user joins a group
          };
        }
      ];
    };
  };
}
```

> **Note:** Both `programs.twindesk` and `services.twindesk` are accepted by the module.

---

## ⚙️ Module Options

| Option | Type | Default | Description |
|---|---|---|---|
| `programs.twindesk.enable` | `bool` | `false` | Enable TwinDesk application and system integration. |
| `programs.twindesk.package` | `package` | `twindesk` | The TwinDesk package derivation to use. |
| `programs.twindesk.user` | `nullOr str` | `null` | Your username. Only used with `inputGroups`. |
| `programs.twindesk.inputGroups` | `bool` | `false` | Also add `user` to the `input` and `uinput` groups. **Not needed**, and it lets every program that user runs read the keyboard and inject input (see below). |
| `programs.twindesk.openFirewall` | `bool` | `true` | Automatically opens TCP port `47800` (peer traffic) and UDP ports `47801` (discovery) & `5353` (mDNS). |
| `programs.twindesk.uinput` | `bool` | `true` | Wayland mouse and keyboard sharing: loads uinput, gives `/dev/uinput` to the `input` group, and installs the helper as `/run/wrappers/bin/twindesk-linuxhelper` (setgid `input`). |
| `programs.twindesk.enableWifiDirect` | `bool` | `true` | Creates `/run/wrappers/bin/twindesk-wifiap` with `CAP_NET_ADMIN` so Wi-Fi Direct interface management works seamlessly without root password prompts. |
| `programs.twindesk.virtualCamera` | `bool` | `true` | Loads the `v4l2loopback` kernel module and adds a `TwinDesk Camera` device at boot, for Camera › Virtual camera. |

---

## 🛠️ Features & How They Work on NixOS

### 1. Wayland Mouse & Keyboard (KVM)
On Wayland no app may read or inject global input, so TwinDesk's helper works under the compositor: it
reads `/dev/input/event*` (to see the mouse cross to the other computer, and the switch hotkey; it grabs
the devices only while this computer drives the other one) and injects through `/dev/uinput`.

**What that access means.** Whoever can read `/dev/input` can read every key typed, and whoever can
write `/dev/uinput` can type and click as you. Membership of the `input` (or `uinput`) group grants
exactly that to *every* program the user runs, and it stays after TwinDesk is gone. So TwinDesk never
puts you in those groups:

- The module installs the helper as a setgid wrapper, `/run/wrappers/bin/twindesk-linuxhelper` (and
  `-multi`), owner `root`, group `input`. Only that helper gets the `input` group. TwinDesk runs it when
  it's there.
- `/dev/uinput` is given to the `input` group (mode `0660`), and `hardware.uinput.enable` loads the module.
- `programs.twindesk.user` no longer adds anyone to a group. Set `programs.twindesk.inputGroups = true;`
  only if you want the old behaviour.

**Undo it.** Set `programs.twindesk.uinput = false;` (or remove `programs.twindesk`) and rebuild. If an
older version of the module added you to `input`/`uinput`, rebuilding with this one takes you out (the
groups are declarative); log out and back in. Check with `id`.

**Other distributions.** Setup › Input access › Fix does the same through one password prompt: a
root-owned, setgid-`input` copy of the helper in `/usr/local/libexec/twindesk/`, a udev rule giving
`/dev/uinput` to `input` (`/etc/udev/rules.d/70-twindesk-uinput.rules`), and `uinput` loaded at boot
(`/etc/modules-load.d/twindesk-uinput.conf`). After an update TwinDesk asks once more, for the new helper.
General › Input access › **Remove** undoes all of it, and takes your account out of `input` if an older
TwinDesk (2.5.1 and earlier) put it there; **Leave the group** does only that. By hand:

```sh
sudo rm -rf /usr/local/libexec/twindesk
sudo rm -f /etc/udev/rules.d/70-twindesk-uinput.rules /etc/udev/rules.d/60-twindesk-uinput.rules /etc/modules-load.d/twindesk-uinput.conf
sudo udevadm control --reload-rules && sudo udevadm trigger --sysname-match=uinput
sudo gpasswd -d "$USER" input   # then log out and back in
```

(`60-twindesk-uinput.rules` is Remote › Real gamepad's: it lets the person at the computer write
`/dev/uinput`, so a game sees the phone as a gamepad. It's set up only when that's turned on.)

### 2. Wi-Fi Direct & Hotspot Links
Creating a secondary access point interface on supported Wi-Fi adapters requires `CAP_NET_ADMIN`.
- The NixOS module automatically configures a security capability wrapper:
  ```nix
  security.wrappers.twindesk-wifiap = {
    source = "${pkg}/libexec/twindesk-wifiap";
    capabilities = "cap_net_admin+ep";
    owner = "root";
    group = "root";
  };
  ```
- TwinDesk automatically detects `/run/wrappers/bin/twindesk-wifiap` and connects without needing `pkexec` prompts.

### 3. Extend (Virtual Displays)
- **GNOME on Wayland**: Uses Mutter's virtual monitor portal. The package wrapper automatically bundles and sets up Python 3 with `pygobject` and `gst-python` with all GStreamer PipeWire plugins and GI typelibs.
- **X11**: The module automatically installs the Polkit policy (`org.twindesk.linux.connector.policy`) and connector script (`twindesk-connector`) into `/run/current-system/sw` so output switching works out of the box.

### 4. Virtual Camera
- The package builds and ships `twindesk-vcam`, the writer behind Camera › Virtual camera.
- TwinDesk's own installer for the `v4l2loopback` module uses `apt`, `dnf` or `pacman`, so on NixOS the module sets it up instead (`virtualCamera`, on by default): it adds `v4l2loopback` to `boot.extraModulePackages` and `boot.kernelModules`, and a `twindesk-vcam` systemd service adds a `TwinDesk Camera` device with `v4l2loopback-ctl`. Reboot (or load the module and `sudo systemctl start twindesk-vcam`) after the first rebuild.
- It sets no `options v4l2loopback` line, so it works beside other users of the module (OBS's virtual camera, say), whose own options stay as they are.
- `v4l2loopback` in `boot.kernelModules` is incompatible with `services.howdy`; if you use Howdy, set `programs.twindesk.virtualCamera = false;`.
- The Camera tab is in the normal window; Multi-device mode has no Camera tab in TwinDesk.
- Virtual Camera currently only works when installed using `programs.twindes`, `nix run` doesn't work because it doesn't create and run the `systemd service`.

### 5. File Sharing & Remote Terminal
- **OpenSSH (Terminal)**: Enable `services.openssh.enable = true;` in your NixOS configuration.
- **Samba (Folder Sharing)**: Enable `services.samba.enable = true;` in your NixOS configuration.
