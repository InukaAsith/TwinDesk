// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// macshare-helper: JSON lines on stdin (requests) / stdout (replies + events). Logs go to stderr.
// Request {"id":1,"cmd":"...",...} -> {"id":1,"ok":true,...} | {"id":1,"ok":false,"error":"..."}.
// Requests without "id" get no reply. Events: {"event":"..."}. Exits when stdin closes.
import Cocoa
import IOKit.hid

// One serial queue writes stdout, so lines never interleave.
let writerQueue = DispatchQueue(label: "macshare.writer")

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else {
    log("cannot encode \(obj)")
    return
  }
  writerQueue.async {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }
}

func log(_ s: String) {
  FileHandle.standardError.write(Data("[helper] \(s)\n".utf8))
}

func reply(_ id: Any?, _ fields: [String: Any] = [:]) {
  guard let id = id else { return }
  var o = fields
  o["id"] = id
  o["ok"] = true
  emit(o)
}

func replyError(_ id: Any?, _ message: String) {
  if id == nil { log("error: \(message)"); return }
  emit(["id": id!, "ok": false, "error": message])
}

let virtualDisplay = VirtualDisplay()
let injector = Injector()
let pasteboardWatch = PasteboardWatch()

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let cmd = msg["cmd"] as? String
  else {
    log("bad line: \(line.prefix(200))")
    return
  }
  let id = msg["id"]
  Capture.shared.touch() // every command is a keepalive for the capture dead-man
  let num = { (k: String, d: Double) in (msg[k] as? NSNumber)?.doubleValue ?? d }
  switch cmd {
  case "kvmConfig":
    guard Capture.shared.startTap() else { return replyError(id, "event tap failed (Accessibility / Input Monitoring)") }
    Flash.shared.prepare()
    // `sides` (every edge with a device behind it); `side` alone is the one edge of older apps.
    let sides = (msg["sides"] as? [String]) ?? [(msg["side"] as? String) ?? "right"]
    Capture.shared.configure(sides: sides, resistance: num("resistancePx", 120),
                             edgeEnabled: (msg["driveOther"] as? Bool) ?? false, keyboard: (msg["keyboard"] as? Bool) ?? true,
                             dragFiles: (msg["dragFiles"] as? Bool) ?? true, hotkey: (msg["hotkey"] as? String) ?? "AltRight")
    Capture.shared.gestures = (msg["gestures"] as? Bool) ?? true
    reply(id)
  case "gesture": // A gesture from the other computer, done by macOS itself
    GesturePost.handle(msg)
  case "capture":
    if (msg["on"] as? Bool) == true {
      Capture.shared.startCapture(mouse: (msg["mouse"] as? Bool) ?? true, keyboard: (msg["keyboard"] as? Bool) ?? true)
      Flash.shared.leave(at: CGEvent(source: nil)?.location ?? .zero, side: nil) // the hotkey
    } else {
      Capture.shared.stopCapture(side: msg["side"] as? String, offset: (msg["offset"] as? NSNumber)?.doubleValue)
    }
    reply(id)
  case "keepalive":
    break
  case "place":
    let center = (msg["center"] as? Bool) == true
    let side = center ? nil : msg["side"] as? String
    let to = Screens.edgePoint(side: side, offset: center ? nil : (msg["offset"] as? NSNumber)?.doubleValue)
    Capture.shared.warp(to)
    Flash.shared.arrive(at: to, side: side) // the PC's pointer arrives here
    reply(id)
  case "armReturn":
    let sides = (msg["sides"] as? [String]) ?? [(msg["side"] as? String) ?? "right"]
    Capture.shared.armReturn(on: (msg["on"] as? Bool) ?? false, sides: sides, resistance: num("resistancePx", 120))
    reply(id)
  case "inject":
    if let ev = msg["ev"] as? [String: Any] { injector.injectRel(ev) }
  case "ping":
    reply(id)
  case "permissions":
    reply(id, [
      "accessibility": AXIsProcessTrusted(),
      "inputMonitoring": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
      "screen": CGPreflightScreenCaptureAccess(),
    ])
  case "notifWatch":
    NotifWatch.shared.set(on: (msg["on"] as? Bool) ?? false)
    reply(id, ["readable": NotifWatch.shared.readable()])
  case "fileSource":
    // Copy shortcut: who is in front, and the files on the clipboard (if any).
    let pb = NSPasteboard.general
    let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    reply(id, ["front": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "",
               "files": urls.map { $0.path }])
  case "requestAccess":
    // Asking registers TwinDesk (our responsible app) in that System Settings list, so the person
    // only flips a switch instead of adding the app with + and a file browser.
    var granted = false
    switch (msg["kind"] as? String) ?? "" {
    case "screen": granted = CGRequestScreenCaptureAccess()
    case "inputMonitoring": granted = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    case "accessibility":
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      granted = AXIsProcessTrustedWithOptions(opts)
    default: break
    }
    reply(id, ["granted": granted])
  case "createDisplay":
    let width = (msg["width"] as? NSNumber)?.intValue ?? 1920
    let height = (msg["height"] as? NSNumber)?.intValue ?? 1080
    let hiDPI = (msg["hiDPI"] as? Bool) ?? false
    let hz = (msg["hz"] as? NSNumber)?.doubleValue ?? 60
    let name = (msg["name"] as? String) ?? "TwinDesk"
    virtualDisplay.create(width: width, height: height, hiDPI: hiDPI, hz: hz, name: name) { result in
      switch result {
      case .success(let info): reply(id, info)
      case .failure(let err): replyError(id, err.message)
      }
    }
  case "input":
    guard let ev = msg["ev"] as? [String: Any], let b = msg["bounds"] as? [String: Any],
          let x = (b["x"] as? NSNumber)?.doubleValue, let y = (b["y"] as? NSNumber)?.doubleValue,
          let w = (b["width"] as? NSNumber)?.doubleValue, let h = (b["height"] as? NSNumber)?.doubleValue
    else { return replyError(id, "input needs ev and bounds") }
    injector.input(ev, bounds: CGRect(x: x, y: y, width: w, height: h))
  case "releaseAll":
    DragIn.shared.cancel() // first: its button must not come up as a drop
    injector.releaseAll()
    reply(id)
  case "clipboardWatch":
    pasteboardWatch.set(on: (msg["on"] as? Bool) ?? false)
    reply(id)
  case "clipboardInfo":
    reply(id, PasteboardWatch.info())
  case "audioCapture":
    AudioCapture.shared.set(on: (msg["on"] as? Bool) ?? false) { err in
      if let err = err { replyError(id, err) } else { reply(id) }
    }
  case "windowAt":
    // Frontmost normal window under a global point (for "drop here"): owner, title, bounds.
    let pt = CGPoint(x: num("x", 0), y: num("y", 0))
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
      guard let b = w[kCGWindowBounds as String] as? [String: Double],
            CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0).contains(pt) else { continue }
      return reply(id, ["owner": w[kCGWindowOwnerName as String] as? String ?? "", "title": w[kCGWindowName as String] as? String ?? "",
                        "bounds": ["x": b["X"] ?? 0, "y": b["Y"] ?? 0, "width": b["Width"] ?? 0, "height": b["Height"] ?? 0]])
    }
    reply(id, ["owner": ""]) // nothing but the desktop
  case "smbMount":
    Smb.mount(url: (msg["url"] as? String) ?? "", user: (msg["user"] as? String) ?? "", password: (msg["password"] as? String) ?? "") { r in
      switch r {
      case .success(let path): reply(id, ["path": path])
      case .failure(let e): replyError(id, e.message)
      }
    }
  case "smbUnmount":
    if let err = Smb.unmount(path: (msg["path"] as? String) ?? "") { replyError(id, err) } else { reply(id) }
  case "appsList":
    reply(id, ["apps": Apps.list()])
  case "appLaunch":
    Apps.launch(id: (msg["appId"] as? String) ?? "") { r in
      switch r {
      case .success(let pid): reply(id, ["pid": pid])
      case .failure(let e): replyError(id, e.message)
      }
    }
  case "appWindows":
    let pids = Set(((msg["pids"] as? [NSNumber]) ?? []).map { $0.intValue })
    reply(id, ["windows": Apps.windows(pids: pids, popups: (msg["popups"] as? Bool) ?? false)])
  case "appResize":
    reply(id, ["done": Apps.resize(wid: (msg["wid"] as? NSNumber)?.intValue ?? 0,
                                   w: (msg["w"] as? NSNumber)?.doubleValue ?? 0, h: (msg["h"] as? NSNumber)?.doubleValue ?? 0)])
  case "appMove":
    if let b = msg["bounds"] as? [String: NSNumber] {
      Apps.moveOnto(pid: (msg["pid"] as? NSNumber)?.intValue ?? 0,
                    bounds: CGRect(x: b["x"]?.doubleValue ?? 0, y: b["y"]?.doubleValue ?? 0,
                                   width: b["width"]?.doubleValue ?? 0, height: b["height"]?.doubleValue ?? 0))
    }
    reply(id)
  case "appFocus":
    reply(id, ["done": Apps.focus(wid: (msg["wid"] as? NSNumber)?.intValue ?? 0)])
  case "appClose":
    reply(id, ["done": Apps.close(wid: (msg["wid"] as? NSNumber)?.intValue ?? 0)])
  case "dragStart":
    DragIn.shared.start(drag: (msg["drag"] as? String) ?? "", items: (msg["items"] as? [[String: Any]]) ?? [])
    reply(id)
  case "dragCancel":
    DragIn.shared.cancel()
    reply(id)
  case "dragWritten":
    DragIn.shared.written(drag: (msg["drag"] as? String) ?? "", index: (msg["index"] as? NSNumber)?.intValue ?? -1,
                          error: msg["error"] as? String)
  case "destroyDisplay":
    virtualDisplay.destroy()
    reply(id)
  default:
    replyError(id, "unknown cmd \(cmd)")
  }
}

DispatchQueue.global().async {
  while let line = readLine() {
    if line.isEmpty { continue }
    DispatchQueue.main.async { handle(line) }
  }
  DispatchQueue.main.async {
    Capture.shared.stopCapture(side: nil, offset: nil) // also shows the pointer again
    injector.releaseAll()
    virtualDisplay.destroy()
    exit(0)
  }
}

signal(SIGTERM) { _ in
  PointerVisibility.show() // never leave the pointer hidden
  exit(0)
}
signal(SIGPIPE, SIG_IGN) // main closed a pipe (e.g. the audio fd): just stop writing
NSApplication.shared.setActivationPolicy(.prohibited)
log("ready")
NSApplication.shared.run()
