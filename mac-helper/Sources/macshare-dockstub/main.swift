// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Dock icon of one PC app. TwinDesk copies this binary into a generated bundle per PC
// app (name + icon in Info.plist / Resources) and runs it while that app has windows on this Mac.
// stdout (lines): `activate` (Dock click, ⌘-Tab), `focus <i>` (Dock menu item), `quit` (Dock › Quit).
// stdin (lines): `menu <JSON array of window titles>`, `exit`. stdin closed → exit.
import Cocoa

final class Stub: NSObject, NSApplicationDelegate {
  var titles: [String] = []
  var parentExit = false

  func out(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    if let url = Bundle.main.url(forResource: "icon", withExtension: "png"), let img = NSImage(contentsOf: url) {
      NSApp.applicationIconImage = img
    }
  }

  func applicationDidBecomeActive(_ n: Notification) { out("activate") }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    out("activate")
    return false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if !parentExit { out("quit") }
    return .terminateNow
  }

  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    for (i, t) in titles.enumerated() {
      let item = NSMenuItem(title: t.isEmpty ? "Window" : t, action: #selector(pick(_:)), keyEquivalent: "")
      item.tag = i
      item.target = self
      menu.addItem(item)
    }
    return menu
  }

  @objc func pick(_ item: NSMenuItem) { out("focus \(item.tag)") }

  func handle(_ line: String) {
    if line == "exit" {
      parentExit = true
      NSApp.terminate(nil)
    } else if line.hasPrefix("menu "), let data = line.dropFirst(5).data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
      titles = arr
    }
  }
}

// Opened on its own (Dock, Launchpad, Spotlight; not started by TwinDesk): ask TwinDesk to open
// this PC app, then leave. TwinDesk starts its own copy of this stub as the Dock icon.
if ProcessInfo.processInfo.environment["MACSHARE_DOCKSTUB"] != "1" {
  let id = (Bundle.main.object(forInfoDictionaryKey: "MacSharePcAppId") as? String) ?? ""
  var allowed = CharacterSet.alphanumerics
  allowed.insert(charactersIn: "-._~")
  if let enc = id.addingPercentEncoding(withAllowedCharacters: allowed), let url = URL(string: "macshare://pc-app/\(enc)") {
    NSWorkspace.shared.open(url)
  }
  exit(0)
}

let stub = Stub()
let app = NSApplication.shared
app.delegate = stub
app.setActivationPolicy(.regular)
DispatchQueue.global().async {
  while let line = readLine() { DispatchQueue.main.async { stub.handle(line) } }
  DispatchQueue.main.async { exit(0) }
}
app.run()
