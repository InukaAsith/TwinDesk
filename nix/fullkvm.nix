# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
#
# Full KVM on NixOS (docs/full-kvm.md, docs/nixos.md).
#
#   fullkvm = import ./nix/fullkvm.nix { inherit self; lib = nixpkgs.lib; };
#
#   fullkvm.package pkgs twindesk   the Full KVM variant of the package: the normal one, plus
#                                   linux/fullkvm and shared/fullkvm (what `TWINDESK_EDITION=full-kvm`
#                                   linux/installer/build.js ships), so shared/edition.js turns the
#                                   hooks and the Full KVM tab's preload on. passthru.fullKvm = true,
#                                   passthru.electron = the Electron the service runs as Node.
#   fullkvm.module                  a NixOS module (imported by nixosModules.twindesk): the options
#                                   {programs,services}.twindesk.{fullKvm,fullKvmMode}, and with
#                                   fullKvm = true what linux/fullkvm/install.sh does by hand on other
#                                   distributions, declared:
#                                     - the package becomes the Full KVM variant (mkDefault);
#                                     - systemd.services.twindesk-fullkvm: service.js as root under
#                                       Electron-as-Node, through the same boot file install.sh writes,
#                                       Restart=always, WantedBy=graphical.target;
#                                     - /etc/twindesk/fullkvm.json: {"mode", "declarative": true};
#                                     - fullKvmMode = "system": the `twindesk` user and group (the machine
#                                       node's account) and /var/lib/twindesk (0700);
#                                     - uinput loaded (the service's helper is MACSHARE_HELPER_BACKEND=uinput,
#                                       as root: no group, no wrapper needed).
#
# The Full KVM tab then shows the configuration's mode and changes nothing (linux/fullkvm/manager.js
# sees "declarative"; /etc/systemd and /usr/local aren't writable on NixOS). The one imperative part is
# System-wide's machine copy of the person's pairings: `twindesk-fullkvm-sync`.
{ self, lib }:

let
  inherit (lib) mkOption mkIf mkMerge mkDefault types;

  # The options, under both programs.twindesk and services.twindesk (the module defines both).
  fullKvmOptions = {
    fullKvm = mkOption {
      type = types.bool;
      default = false;
      description = ''
        The Full KVM build (docs/full-kvm.md): the mesh's mouse and keyboard on the lock screen, polkit
        dialogs and, with fullKvmMode = "system", the login screen. Uses the Full KVM variant of the package
        (unless `package` is set) and declares the `twindesk-fullkvm` system service that the Full KVM tab
        would otherwise install through pkexec; the tab then shows this configuration and changes nothing.
        The service runs as root: it reads /dev/input and writes /dev/uinput, and hands them to the person
        signed in on seat0 over /run/twindesk/kvm.sock (mode 0600, theirs).
      '';
    };

    fullKvmMode = mkOption {
      type = types.enum [ "simple" "system" ];
      default = "simple";
      description = ''
        "simple" (Signed in on the tab): the lock screen, polkit dialogs and windows run as administrator,
        while someone is signed in. "system" (Always): also the login screen: the service keeps this computer
        in the mesh with a copy of the pairings, as the unprivileged `twindesk` user (created here, home
        /var/lib/twindesk). The copy is made by running `twindesk-fullkvm-sync` once, as the person whose
        TwinDesk is paired (again after pairing changes).
      '';
    };
  };

  # The Full KVM variant. Everything the normal build copies stays; flake.nix's installPhase removes
  # shared/fullkvm and never copies linux/fullkvm, so they are put back after it (postInstall).
  package = pkgs: base:
    base.overrideAttrs (old: {
      pname = "twindesk-fullkvm";
      postInstall = (old.postInstall or "") + ''
        # The Full KVM build's own folders (linux/installer/build.js with TWINDESK_EDITION=full-kvm),
        # without their dev test.
        local share="$out/share/twindesk"
        cp -r --no-preserve=mode linux/fullkvm "$share/linux/fullkvm"
        rm -rf "$share/linux/fullkvm/test"
        cp -r --no-preserve=mode shared/fullkvm "$share/shared/fullkvm"
        test -f "$share/shared/fullkvm/svc-link.js"   # shared/edition.js looks for it
        test -f "$share/linux/fullkvm/service.js"
      '';
      passthru = (old.passthru or { }) // {
        fullKvm = true;
        electron = pkgs.electron;
      };
    });

  module = { config, pkgs, ... }:
    let
      pt = config.programs.twindesk;
      sv = config.services.twindesk;
      # The same choice as the main module: programs.twindesk when it is enabled, else services.twindesk.
      cfg = if pt.enable then pt else sv;
      enabled = (pt.enable || sv.enable) && cfg.fullKvm;
      pkg = cfg.package;
      system = cfg.fullKvmMode == "system";

      share = "${pkg}/share/twindesk";
      # The boot file install.sh writes to /usr/local/lib/twindesk, in the store.
      boot = pkgs.writeText "twindesk-fullkvm-boot.js" ''
        // Starts the Full KVM service from the TwinDesk app (nix/fullkvm.nix; install.sh writes the same).
        require("${share}/linux/fullkvm/service.js").main();
      '';
      electron = pkg.passthru.electron or pkgs.electron;

      # What the helper and the machine node may run (service.js PATH): openssl for a certificate (identity.js),
      # ip, loginctl.
      servicePath = lib.makeBinPath [ pkgs.openssl pkgs.iproute2 config.systemd.package ];

      # System-wide's machine copy of the person's settings folder: install.sh sync, as root through pkexec,
      # as the Full KVM tab does it elsewhere (the script's text through `sh -c`; it checks the folder is theirs).
      sync = pkgs.writeShellScriptBin "twindesk-fullkvm-sync" ''
        set -eu
        dir=''${1:-''${XDG_CONFIG_HOME:-$HOME/.config}/MacShare}
        exec /run/wrappers/bin/pkexec ${pkgs.coreutils}/bin/env \
          PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnugrep pkgs.gnused config.systemd.package ]} \
          ${pkgs.runtimeShell} -c "$(${pkgs.coreutils}/bin/cat ${share}/linux/fullkvm/install.sh)" install.sh sync "$dir"
      '';
    in
    {
      options.programs.twindesk = fullKvmOptions;
      options.services.twindesk = fullKvmOptions;

      config = mkMerge [
        # The package follows fullKvm, unless the person set one (then it must be a Full KVM one).
        {
          programs.twindesk.package = mkIf pt.fullKvm (mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.twindesk-fullkvm);
          services.twindesk.package = mkIf sv.fullKvm (mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.twindesk-fullkvm);
        }

        (mkIf enabled {
          assertions = [{
            assertion = pkg.passthru.fullKvm or false;
            message = "programs.twindesk.fullKvm needs the Full KVM package (twindesk-fullkvm, or `fullkvm.package pkgs yourPackage`), but programs.twindesk.package is another one.";
          }];

          # The service's helper is the uinput backend as root: the module, not the group.
          hardware.uinput.enable = mkDefault true;

          environment.etc."twindesk/fullkvm.json".text = builtins.toJSON {
            mode = cfg.fullKvmMode;
            declarative = true; # linux/fullkvm/manager.js and install.sh: nothing for them to install or change
          };

          systemd.services.twindesk-fullkvm = {
            description = "TwinDesk Full KVM: the mesh's mouse and keyboard on the lock and login screens";
            wantedBy = [ "graphical.target" ];
            after = [ "systemd-logind.service" ];
            # A new mode (the json above) restarts it, as install.sh's `mode` signals it.
            restartTriggers = [ config.environment.etc."twindesk/fullkvm.json".source ];
            path = [ config.systemd.package ]; # loginctl: whose seat0 it is
            environment = {
              ELECTRON_RUN_AS_NODE = "1";
              TWINDESK_FULLKVM_PATH = servicePath;
            };
            serviceConfig = {
              Type = "simple";
              ExecStart = "${electron}/bin/electron ${boot}";
              Restart = "always";
              RestartSec = 2;
            };
          };

          environment.systemPackages = lib.optional system sync;
        })

        # System-wide: the machine node's account and its folder (install.sh's account()).
        (mkIf (enabled && system) {
          users.users.twindesk = {
            isSystemUser = true;
            group = "twindesk";
            home = "/var/lib/twindesk";
            description = "TwinDesk Full KVM machine node";
          };
          users.groups.twindesk = { };
          systemd.tmpfiles.rules = [ "d /var/lib/twindesk 0700 twindesk twindesk -" ];
        })
      ];
    };
in
{
  inherit package module fullKvmOptions;
}
