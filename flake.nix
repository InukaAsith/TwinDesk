{
  description = "TwinDesk — All your computers and your phone, working as one desk";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      nixpkgsFor = forAllSystems (system: import nixpkgs { inherit system; });
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgsFor.${system};
          pythonEnv = pkgs.python3.withPackages (ps: [
            ps.pygobject3
            ps.gst-python
          ]);
          wsSource = pkgs.fetchurl {
            url = "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz";
            hash = "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==";
          };
        in
        rec {
          twindesk = pkgs.stdenv.mkDerivation rec {
            pname = "twindesk";
            version = "3.0.0";

            src = self;

            nativeBuildInputs = [
              pkgs.pkg-config
              pkgs.makeWrapper
            ];

            buildInputs = [
              pkgs.glib
              pkgs.libx11
              pkgs.libxi
              pkgs.libxtst
              pkgs.libxext
              pkgs.libxrandr
              pkgs.libxfixes
            ];

            runtimeDeps = [
              pkgs.electron
              pkgs.openssl
              pkgs.dbus
              pkgs.glib
              pkgs.pulseaudio
              pkgs.xdg-utils
              pkgs.networkmanager
              pkgs.android-tools
              pkgs.xrandr
              pythonEnv
            ];

            buildPhase = ''
              runHook preBuild

              mkdir -p linux-helper/bin
              BLE_FLAGS="$(pkg-config --cflags --libs gio-2.0)"

              $CC -O2 -Wall -Wextra -std=gnu11 linux-helper/src/*.c \
                -o linux-helper/bin/macshare-linuxhelper \
                -lX11 -lXi -lXtst -lXext -lXrandr -lXfixes -lm -pthread \
                -DHAVE_BLE $BLE_FLAGS

              $CC -O2 -Wall -Wextra -std=gnu11 -DMULTI linux-helper/src/*.c \
                -o linux-helper/bin/macshare-linuxhelper-multi \
                -lX11 -lXi -lXtst -lXext -lXrandr -lXfixes -lm -pthread \
                -DHAVE_BLE $BLE_FLAGS

              $CC -O2 -Wall -Wextra -std=gnu11 linux-helper/wifiap/wifiap.c \
                -o linux-helper/bin/twindesk-wifiap

              $CC -O2 -Wall -Wextra -std=gnu11 linux-helper/pad/pad.c                 -o linux-helper/bin/twindesk-pad

              # Camera > Virtual camera's writer (linux/vcam.js); without it the switch says "Not in this build"
              $CC -O2 -Wall -Wextra -std=gnu11 linux-helper/vcam/vcam.c               -o linux-helper/bin/twindesk-vcam

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              local share="$out/share/twindesk"
              mkdir -p "$share/linux" "$share/shared" "$share/linux-helper/bin" "$share/linux/vendor" "$share/node_modules/ws"
              mkdir -p "$out/bin" "$out/libexec" "$out/share/applications" "$out/share/icons/hicolor/512x512/apps" "$out/share/polkit-1/actions"

              # Copy Linux app sources
              cp -r linux/*.js linux/*.css linux/*.html linux/assets linux/mesh "$share/linux/"
              cp linux/package.json "$share/linux/"

              # Copy shared files
              cp -r shared/*.js shared/*.css shared/*.html "$share/shared/"
              if [ -d shared/icon ]; then
                cp -r shared/icon "$share/shared/"
              fi
              cp -r shared/lang "$out/share/twindesk/shared/"

              # Copy helper binaries
              cp linux-helper/bin/macshare-linuxhelper "$share/linux-helper/bin/"
              cp linux-helper/bin/macshare-linuxhelper-multi "$share/linux-helper/bin/"
              cp linux-helper/bin/twindesk-wifiap "$share/linux-helper/bin/"
              cp linux-helper/bin/twindesk-pad "$share/linux-helper/bin/"
              cp linux-helper/bin/twindesk-vcam "$share/linux-helper/bin/"
              cp linux-helper/bin/twindesk-wifiap "$out/libexec/twindesk-wifiap"

              # Install twindesk-connector helper and polkit policy for Extend virtual display
              cat << 'EOF' > "$out/libexec/twindesk-connector"
#!/bin/sh
case "$1" in on|detect) ;; *) echo "usage: twindesk-connector on|detect <connector>" >&2; exit 2 ;; esac
case "$2" in ""|*[!A-Za-z0-9-]*) echo "bad connector name: $2" >&2; exit 2 ;; esac
for f in /sys/class/drm/card[0-9]-"$2"/status /sys/class/drm/card[0-9][0-9]-"$2"/status; do
  [ -f "$f" ] && { echo "$1" > "$f"; exit; }
done
echo "no connector $2" >&2
exit 1
EOF
              chmod +x "$out/libexec/twindesk-connector"

              cat << 'EOF' > "$out/share/polkit-1/actions/org.twindesk.linux.connector.policy"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>TwinDesk</vendor>
  <vendor_url>https://github.com/InukaAsith/TwinDesk</vendor_url>
  <action id="org.twindesk.linux.connector">
    <description>Switch a spare display output on for TwinDesk's Extend</description>
    <message>TwinDesk wants to switch a spare display output on or off</message>
    <defaults>
      <allow_any>auth_admin</allow_any>
      <allow_inactive>auth_admin</allow_inactive>
      <allow_active>yes</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">/run/current-system/sw/libexec/twindesk-connector</annotate>
  </action>
</policyconfig>
EOF

              # Copy bundled scrcpy-server if present
              if [ -f mac/vendor/scrcpy-server ]; then
                cp mac/vendor/scrcpy-server "$share/linux/vendor/scrcpy-server"
              fi

              # Unpack ws dependency into node_modules
              tar -xzf ${wsSource} -C "$share/node_modules/ws" --strip-components=1

              # Desktop entry & icon
              cp linux/assets/icon.png "$out/share/icons/hicolor/512x512/apps/twindesk.png"

              cat << 'EOF' > "$out/share/applications/twindesk.desktop"
[Desktop Entry]
Name=TwinDesk
Comment=Share mouse, keyboard, clipboard, files and screens with your other computer
Exec=twindesk %U
Icon=twindesk
Type=Application
StartupWMClass=TwinDesk
Categories=Utility;
Keywords=KVM;mouse;keyboard;clipboard;screen;share;
EOF

              # Electron wrapper
              makeWrapper ${pkgs.electron}/bin/electron "$out/bin/twindesk" \
                --add-flags "$share/linux/main.js" \
                --set NODE_PATH "$share/node_modules" \
                --set TWINDESK_BIN "$out/bin/twindesk" \
                --prefix PATH : ${pkgs.lib.makeBinPath runtimeDeps} \
                --prefix GI_TYPELIB_PATH : "${pkgs.lib.makeSearchPath "lib/girepository-1.0" [ pkgs.glib pkgs.gobject-introspection pkgs.gst_all_1.gstreamer pkgs.gst_all_1.gst-plugins-base ]}" \
                --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${pkgs.lib.makeSearchPath "lib/gstreamer-1.0" [ pkgs.gst_all_1.gstreamer pkgs.gst_all_1.gst-plugins-base ]}"

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "All your computers and your phone, working as one desk";
              homepage = "https://github.com/InukaAsith/TwinDesk";
              license = licenses.gpl3Only;
              platforms = supportedSystems;
              mainProgram = "twindesk";
            };
          };

          default = twindesk;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/twindesk";
          meta.description = "TwinDesk multi-device desktop app";
        };
      });

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgsFor.${system};
          pythonEnv = pkgs.python3.withPackages (ps: [
            ps.pygobject3
            ps.gst-python
          ]);
        in
        {
          default = pkgs.mkShell {
            name = "twindesk-dev";
            packages = [
              pkgs.nodejs
              pkgs.electron
              pkgs.pkg-config
              pkgs.gcc
              pkgs.glib
              pkgs.libx11
              pkgs.libxi
              pkgs.libxtst
              pkgs.libxrandr
              pkgs.libxfixes
              pkgs.openssl
              pkgs.dbus
              pkgs.pulseaudio
              pkgs.xdg-utils
              pkgs.networkmanager
              pkgs.android-tools
              pkgs.gobject-introspection
              pkgs.gst_all_1.gstreamer
              pkgs.gst_all_1.gst-plugins-base
              pythonEnv
            ];

            shellHook = ''
              export GI_TYPELIB_PATH="${pkgs.lib.makeSearchPath "lib/girepository-1.0" [ pkgs.glib pkgs.gobject-introspection pkgs.gst_all_1.gstreamer pkgs.gst_all_1.gst-plugins-base ]}:$GI_TYPELIB_PATH"
              export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.lib.makeSearchPath "lib/gstreamer-1.0" [ pkgs.gst_all_1.gstreamer pkgs.gst_all_1.gst-plugins-base ]}:$GST_PLUGIN_SYSTEM_PATH_1_0"
            '';
          };
        }
      );

      overlays.default = final: prev: {
        twindesk = self.packages.${final.system}.twindesk;
      };

      nixosModules = rec {
        twindesk = { config, lib, pkgs, ... }:
          with lib;
          let
            mkTwindeskOptions = {
              enable = mkEnableOption "TwinDesk multi-device sharing";

              package = mkOption {
                type = types.package;
                default = self.packages.${pkgs.system}.default;
                description = "The TwinDesk package to use.";
              };

              openFirewall = mkOption {
                type = types.bool;
                default = true;
                description = "Whether to open required firewall ports (TCP 47800, UDP 47801, and UDP 5353 for mDNS).";
              };

              uinput = mkOption {
                type = types.bool;
                default = true;
                description = ''
                  Wayland mouse and keyboard sharing: loads uinput, gives /dev/uinput to the input group, and
                  installs the TwinDesk helper as a setgid input wrapper (/run/wrappers/bin/twindesk-linuxhelper),
                  so the helper alone can read /dev/input and write /dev/uinput. No user is added to a group.
                '';
              };

              user = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Your user name. Only used with inputGroups.";
              };

              inputGroups = mkOption {
                type = types.bool;
                default = false;
                description = ''
                  Also add `user` to the input and uinput groups. TwinDesk doesn't need this (its helper has the
                  input group on its own), and it lets every program that user runs read the keyboard and inject
                  input. Leave it off unless you know you want it.
                '';
              };

              enableWifiDirect = mkOption {
                type = types.bool;
                default = true;
                description = "Whether to configure security.wrappers for twindesk-wifiap with CAP_NET_ADMIN.";
              };

              virtualCamera = mkOption {
                type = types.bool;
                default = true;
                description = ''
                  Whether to provide a "TwinDesk Camera" v4l2loopback device for Camera > Virtual camera.
                  TwinDesk's own installer for it needs apt, dnf or pacman, which NixOS doesn't have. This loads
                  the v4l2loopback module and adds the device at boot with v4l2loopback-ctl, without touching
                  boot.extraModprobeConfig, so it works beside other v4l2loopback users (OBS's virtual camera,
                  say).
                '';
              };
            };

            cfg = if config.programs.twindesk.enable then config.programs.twindesk else config.services.twindesk;
            enabled = config.services.twindesk.enable || config.programs.twindesk.enable;
          in
          {
            options.services.twindesk = mkTwindeskOptions;
            options.programs.twindesk = mkTwindeskOptions;

            config = mkIf enabled {
              environment.systemPackages = [ cfg.package ];

              # Ensure polkit is enabled for Virtual Display connector and privileged helpers
              security.polkit.enable = mkDefault true;

              # Open ports for TwinDesk communication and discovery
              networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ 47800 ];
              networking.firewall.allowedUDPPorts = mkIf cfg.openFirewall [ 47801 5353 ];

              # Wayland input emulation
              hardware.uinput.enable = mkIf cfg.uinput true;
              services.udev.extraRules = mkIf cfg.uinput ''
                KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
              '';

              # Only with inputGroups: the user in the input groups (every program of theirs can then read
              # the keyboard; TwinDesk doesn't need it, #144).
              users.users = mkIf (cfg.uinput && cfg.inputGroups && cfg.user != null) {
                ${cfg.user}.extraGroups = [ "input" "uinput" ];
              };

              # Virtual camera: a v4l2loopback device named "TwinDesk Camera" (linux/vcam.js looks it up by that name).
              # Added at runtime rather than through `options v4l2loopback ...` in boot.extraModprobeConfig:
              # those lines from different modules (OBS, ...) don't merge.
              boot.extraModulePackages = mkIf cfg.virtualCamera [ config.boot.kernelPackages.v4l2loopback ];
              boot.kernelModules = mkIf cfg.virtualCamera [ "v4l2loopback" ];
              systemd.services.twindesk-vcam = mkIf cfg.virtualCamera {
                description = "TwinDesk virtual camera device (v4l2loopback)";
                wantedBy = [ "multi-user.target" ];
                wants = [ "modprobe@v4l2loopback.service" ];
                after = [ "systemd-modules-load.service" "modprobe@v4l2loopback.service" ];
                serviceConfig = {
                  Type = "oneshot";
                  RemainAfterExit = true;
                };
                script = ''
                  for f in /sys/class/video4linux/*/name; do
                    read -r name 2>/dev/null < "$f" || continue
                    [ "$name" = "TwinDesk Camera" ] && exit 0
                  done
                  ${config.boot.kernelPackages.v4l2loopback.bin}/bin/v4l2loopback-ctl add -x 1 -n "TwinDesk Camera"
                '';
              };

              warnings = optional (cfg.user != null && !cfg.inputGroups)
                "programs.twindesk.user no longer adds ${cfg.user} to the input and uinput groups: the TwinDesk helper has the input group on its own (a setgid wrapper). Set programs.twindesk.inputGroups = true only if you want the old behaviour.";

              security.wrappers = mkMerge [
                # The helper alone gets the input group (setgid): it reads /dev/input and writes /dev/uinput
                # for Wayland sharing (linux/system.js helperBin).
                (mkIf cfg.uinput {
                  twindesk-linuxhelper = {
                    source = "${cfg.package}/share/twindesk/linux-helper/bin/macshare-linuxhelper";
                    setgid = true;
                    owner = "root";
                    group = "input";
                  };
                  twindesk-linuxhelper-multi = {
                    source = "${cfg.package}/share/twindesk/linux-helper/bin/macshare-linuxhelper-multi";
                    setgid = true;
                    owner = "root";
                    group = "input";
                  };
                })
                # Wi-Fi Direct helper security wrapper with CAP_NET_ADMIN
                (mkIf cfg.enableWifiDirect {
                  twindesk-wifiap = {
                    source = "${cfg.package}/libexec/twindesk-wifiap";
                    capabilities = "cap_net_admin+ep";
                    owner = "root";
                    group = "root";
                  };
                })
              ];
            };
          };

        default = twindesk;
      };
    };
}
