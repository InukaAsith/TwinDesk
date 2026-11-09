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

/// kvmConfig / armReturn `zones` (shared/kvm-geom.js zonesText): "0.1-0.5,0.7-1" (a little wider,
/// for rounding), "none" (nothing crosses), anything else nil (the whole side).
func zones(_ v: Any?) -> [ClosedRange<Double>]? {
  guard let text = v as? String else { return nil }
  if text == "none" { return [] }
  let out = text.split(separator: ",").compactMap { part -> ClosedRange<Double>? in
    let ab = part.split(separator: "-").compactMap { Double($0) }
    return ab.count == 2 && ab[0] <= ab[1] ? (ab[0] - 0.002)...(ab[1] + 0.002) : nil
  }
  return out.isEmpty ? nil : out
}

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
    Capture.shared.edgeZones = zones(msg["zones"])
    Capture.shared.takeBack = (msg["takeBack"] as? Bool) ?? true
    guard Capture.shared.startTap() else { return replyError(id, "event tap failed (Accessibility / Input Monitoring)") }
    Flash.shared.prepare()
#if MULTI
    // `sides` (every edge with a device behind it, Multi-device); `side` alone is one edge.
    let sides = (msg["sides"] as? [String]) ?? [(msg["side"] as? String) ?? "right"]
    Capture.shared.configure(sides: sides, resistance: num("resistancePx", 120),
                             edgeEnabled: (msg["driveOther"] as? Bool) ?? false, keyboard: (msg["keyboard"] as? Bool) ?? true,
                             dragFiles: (msg["dragFiles"] as? Bool) ?? true, hotkey: (msg["hotkey"] as? String) ?? "AltRight",
                             cooldown: num("cooldownMs", 250) / 1000)
#else
    Capture.shared.configure(side: (msg["side"] as? String) ?? "right", resistance: num("resistancePx", 120),
                             edgeEnabled: (msg["driveOther"] as? Bool) ?? false, keyboard: (msg["keyboard"] as? Bool) ?? true,
                             dragFiles: (msg["dragFiles"] as? Bool) ?? true, hotkey: (msg["hotkey"] as? String) ?? "AltRight",
                             cooldown: num("cooldownMs", 250) / 1000)
#endif
    Capture.shared.gestures = (msg["gestures"] as? Bool) ?? true
    Capture.shared.dwell = num("dwellMs", 150) / 1000
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
    Capture.shared.arrived(side: side)
    Flash.shared.arrive(at: to, side: side) // the PC's pointer arrives here
    reply(id)
  case "armReturn":
    Capture.shared.returnZones = zones(msg["zones"])
#if MULTI
    let sides = (msg["sides"] as? [String]) ?? [(msg["side"] as? String) ?? "right"]
    Capture.shared.armReturn(on: (msg["on"] as? Bool) ?? false, sides: sides, resistance: num("resistancePx", 120))
#else
    Capture.shared.armReturn(on: (msg["on"] as? Bool) ?? false, side: (msg["side"] as? String) ?? "right",
                             resistance: num("resistancePx", 120))
#endif
    reply(id)
  case "inject":
    if let ev = msg["ev"] as? [String: Any] { injector.injectRel(ev) }
#if TDFAST
  case "lane": // the input lane (Lane.swift, native/tdfast)
    NativeLane.shared.handle(msg, id: id)
#endif
  case "ping":
    reply(id)
  case "caps": // Caps Lock, as the other computer's (#131)
    reply(id, ["on": injector.caps(set: msg["set"] as? Bool)])
  case "keyLayout": // what each key types alone and with Shift in the current layout (shared/keylayout.js); type: it takes "type"
    let source = msg["source"] as? String
    var r: [String: Any] = ["layout": KeyLayout.current(sourceID: source), "shift": KeyLayout.current(sourceID: source, shift: true),
                            "type": true, "selectInput": true]
    if let im = InputSources.currentIM() { r["im"] = im } // typing with an input method: its language
    reply(id, r)
  case "selectInput": // an input method of the other computer's language ({lang}), or back to ours ({restore})
    if (msg["restore"] as? Bool) == true { InputSources.restore(); reply(id) }
    else { reply(id, ["found": InputSources.select(language: (msg["lang"] as? String) ?? "")]) }
  case "type": // text as it is, whatever the layout
    if let text = msg["text"] as? String { injector.type(text) }
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
  case "frontWatch": // ReZume: the app or window in front changed (FrontWatch.swift), so main looks only then
    reply(id, ["ax": FrontWatch.shared.set(on: (msg["on"] as? Bool) ?? false)])
  case "usbWatch": // a phone with USB debugging plugged in or out (UsbWatch.swift): events, not polling
    reply(id, ["present": UsbWatch.shared.start()])
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
  case "appPlace":
    reply(id, ["done": Apps.place(wid: (msg["wid"] as? NSNumber)?.intValue ?? 0,
                                  x: (msg["x"] as? NSNumber)?.doubleValue ?? 0, y: (msg["y"] as? NSNumber)?.doubleValue ?? 0)])
  case "moveWin": // Apps › Move windows: the key held to grab a window, "" = off
    WindowGrab.shared.setKey((msg["key"] as? String) ?? "")
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
  case "dragLocal": // our own files, dragged back home with the button still held: a drag of them here
    DragIn.shared.startLocal(drag: (msg["drag"] as? String) ?? "local", paths: (msg["paths"] as? [String]) ?? [])
    reply(id)
  case "dragWritten":
    DragIn.shared.written(drag: (msg["drag"] as? String) ?? "", index: (msg["index"] as? NSNumber)?.intValue ?? -1,
                          error: msg["error"] as? String)
  case "destroyDisplay":
    virtualDisplay.destroy()
    reply(id)
  case "bleStart":
    BlePeripheral.shared.start(info: Data(((msg["info"] as? String) ?? "{}").utf8))
    reply(id)
  case "bleStop":
    BlePeripheral.shared.stop()
    reply(id)
  case "bleHold":
    BlePeripheral.shared.hold(advertise: (msg["advertise"] as? Bool) ?? false)
    reply(id)
  case "bleSend":
    if let dev = msg["dev"] as? String, let b64 = msg["data"] as? String, let data = Data(base64Encoded: b64) {
      BlePeripheral.shared.send(dev: dev, data: data)
    }
  case "bleCtrl":
    if let dev = msg["dev"] as? String, let text = msg["msg"] as? String { BlePeripheral.shared.ctrl(dev: dev, text: text) }
  case "bleLook":
    BleLook.shared.look((msg["on"] as? Bool) ?? false)
    reply(id)
  case "bleInvite":
    if let dev = msg["dev"] as? String, let text = msg["msg"] as? String { BleLook.shared.invite(dev: dev, text: text) }
    reply(id)
  case "wifiInfo":
    reply(id, WifiCtl.shared.info())
  case "wifiLocation":
    WifiCtl.shared.askLocation()
    reply(id)
  case "wifiJoin":
    WifiCtl.shared.join(ssid: (msg["ssid"] as? String) ?? "", password: (msg["password"] as? String) ?? "") { err in
      if let err = err { replyError(id, err) } else { reply(id) }
    }
  case "wifiLeave":
    WifiCtl.shared.leave { reply(id) }
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

// Killed or hung up: never leave the pointer hidden or frozen. (A crash ends our WindowServer
// connection, which shows the pointer and frees it by itself; main's helper.on('exit') goes home.)
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig) { _ in
    CGAssociateMouseAndMouseCursorPosition(1)
    PointerVisibility.show()
    exit(0)
  }
}
signal(SIGPIPE, SIG_IGN) // main closed a pipe (e.g. the audio fd): just stop writing
NSApplication.shared.setActivationPolicy(.prohibited)
log("ready")
NSApplication.shared.run()
