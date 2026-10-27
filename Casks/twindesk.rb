cask "twindesk" do
  arch arm: "arm64", intel: "x64_Intel"

  version "2.3.0"
  sha256 arm:   "646c29b0c408c15fc971de2d7a10108f26d77ed64dc8fe859178b3ae7511fe65",
         intel: "b8128ef396092f90716f3712119b279685f5e77ab5dd8925bf7006652ab080d3"

  url "https://github.com/InukaAsith/TwinDesk/releases/download/v#{version}/TwinDesk-#{version}-#{arch}.dmg"
  name "TwinDesk"
  desc "Share mouse, keyboard, screen and clipboard across Mac, Windows, Linux, and Android"
  homepage "https://github.com/InukaAsith/TwinDesk"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TwinDesk.app"

  preflight do
    # When updating a running instance on a headless or mouse-less Mac, smoothly close it
    # without failing the Homebrew upgrade process
    was_running = system_command("/usr/bin/pgrep", args: ["-x", "TwinDesk"], result_type: :exit_status).zero?
    File.write("#{staged_path}/.was_running", "1") if was_running
    system_command "/usr/bin/pkill", args: ["-x", "TwinDesk"], sudo: false if was_running
  end

  postflight do
    # 1. Clear quarantine extended attribute to prevent macOS Gatekeeper "Move to Bin" warning
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{appdir}/TwinDesk.app"],
                   sudo: false

    # 2. If TwinDesk was active before upgrading, relaunch it immediately so remote KVM
    # mouse and keyboard control is instantly restored without stranding the user
    if File.exist?("#{staged_path}/.was_running")
      system_command "/usr/bin/open", args: ["-a", "#{appdir}/TwinDesk.app"], sudo: false
    end
  end

  uninstall quit: "org.macshare.mac"

  zap trash: [
    "~/Library/Application Support/MacShare",
    "~/Library/Preferences/org.macshare.mac.plist",
    "~/Library/Saved Application State/org.macshare.mac.savedState",
  ]
end
