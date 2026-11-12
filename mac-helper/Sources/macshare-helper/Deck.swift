// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's way into this Mac (shared/deck-sys.js), all in this process: no other program is
// started for any of it, only macOS's own frameworks.
//   deckAudio -> {outputs: [{id, name, on}], inputs: [...], volume, muted, micVolume, micMuted}
//   deckAudioDefault {id, input}: that device becomes the default output (or input)
//   deckVolume {input, level?, mute?}
//   deckBt -> {radio, devices: [{id, name, connected, audio}]}; deckBtRadio {on}; deckBtConnect {id, on}
//   deckBright -> {displays: [{id, name, level, internal}]}: displays macOS sets the brightness of
//     (built-in ones and Apple's own); deckBrightSet {id, level} (id "" = all of them)
//   deckWins -> {windows: [{wid, pid, app, bundle, title, x, y, w, h}], minimized: [{wid, pid, app, bundle, title}], front}: regular apps' windows
//   deckWinFrame {wid, x, y, w, h} (wid 0: the one in front); deckWinOp {wid, op: min|full|close|restore}
//   deckSys {what: sleep|screenoff|lock|darkmode|desktop|overview}
//   deckState -> {dark, memUsed 0–1, temp °C (Apple silicon; absent when unknown)}
import Cocoa
import CoreAudio
import IOBluetooth
import IOKit.pwr_mgt

enum Deck {
  // MARK: Sound
  private static func prop(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  }

  private static func devices() -> [AudioDeviceID] {
    var a = prop(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
  }

  private static func streams(_ d: AudioDeviceID, input: Bool) -> Bool {
    var a = prop(kAudioDevicePropertyStreams, input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(d, &a, 0, nil, &size) == noErr && size > 0
  }

  private static func string(_ d: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
    var a = prop(sel)
    var v: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(d, &a, 0, nil, &size, &v) == noErr, let s = v?.takeRetainedValue() else { return "" }
    return s as String
  }

  private static func defaultDevice(input: Bool) -> AudioDeviceID {
    var a = prop(input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
    var d = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &d)
    return d
  }

  private static func isHidden(_ d: AudioDeviceID) -> Bool {
    var a = prop(kAudioDevicePropertyIsHidden)
    var v: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(d, &a, 0, nil, &size, &v) == noErr && v != 0
  }

  private static func list(input: Bool) -> [[String: Any]] {
    let def = defaultDevice(input: input)
    return devices().filter { streams($0, input: input) && !isHidden($0) }.map {
      ["id": string($0, kAudioDevicePropertyDeviceUID), "name": string($0, kAudioObjectPropertyName), "on": $0 == def]
    }
  }

  // The device's level: its main element, else the first channels' average.
  private static func level(_ d: AudioDeviceID, input: Bool) -> Double? {
    let scope = input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput
    for el: UInt32 in [0, 1, 2] {
      var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: scope, mElement: el)
      var v: Float32 = 0
      var size = UInt32(MemoryLayout<Float32>.size)
      if AudioObjectHasProperty(d, &a), AudioObjectGetPropertyData(d, &a, 0, nil, &size, &v) == noErr { return Double(v) }
    }
    return nil
  }

  private static func setLevel(_ d: AudioDeviceID, input: Bool, _ l: Double) -> Bool {
    let scope = input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput
    var v = Float32(max(0, min(1, l)))
    var main = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: scope, mElement: 0)
    if AudioObjectHasProperty(d, &main) {
      return AudioObjectSetPropertyData(d, &main, 0, nil, UInt32(MemoryLayout<Float32>.size), &v) == noErr
    }
    var any = false
    for el: UInt32 in [1, 2] { // no main volume: the left and right channels
      var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: scope, mElement: el)
      if AudioObjectHasProperty(d, &a), AudioObjectSetPropertyData(d, &a, 0, nil, UInt32(MemoryLayout<Float32>.size), &v) == noErr { any = true }
    }
    return any
  }

  private static func muted(_ d: AudioDeviceID, input: Bool) -> Bool? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput, mElement: 0)
    var v: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectHasProperty(d, &a), AudioObjectGetPropertyData(d, &a, 0, nil, &size, &v) == noErr else { return nil }
    return v != 0
  }

  // A microphone without a mute switch is muted by its level (kept to give back).
  private static var micLevelBeforeMute: [AudioDeviceID: Double] = [:]

  private static func setMute(_ d: AudioDeviceID, input: Bool, _ on: Bool) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput, mElement: 0)
    var settable: DarwinBoolean = false
    if AudioObjectHasProperty(d, &a), AudioObjectIsPropertySettable(d, &a, &settable) == noErr, settable.boolValue {
      var v: UInt32 = on ? 1 : 0
      return AudioObjectSetPropertyData(d, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr
    }
    guard input else { return false }
    if on {
      if let l = level(d, input: true), l > 0 { micLevelBeforeMute[d] = l }
      return setLevel(d, input: true, 0)
    }
    return setLevel(d, input: true, micLevelBeforeMute.removeValue(forKey: d) ?? 0.75)
  }

  static func audio() -> [String: Any] {
    var r: [String: Any] = ["outputs": list(input: false), "inputs": list(input: true)]
    let o = defaultDevice(input: false), i = defaultDevice(input: true)
    if let v = level(o, input: false) { r["volume"] = v }
    if let m = muted(o, input: false) { r["muted"] = m }
    if let v = level(i, input: true) { r["micVolume"] = v }
    r["micMuted"] = muted(i, input: true) ?? ((level(i, input: true) ?? 1) == 0)
    return r
  }

  static func setDefault(uid: String, input: Bool) throws {
    guard let d = devices().first(where: { string($0, kAudioDevicePropertyDeviceUID) == uid && streams($0, input: input) }) else {
      throw HelperError(message: "That sound device isn’t connected")
    }
    var dev = d
    var a = prop(input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
    guard AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &dev) == noErr else {
      throw HelperError(message: "macOS didn’t switch the sound device")
    }
    if !input { // system sounds follow, as the Sound menu does
      var s = prop(kAudioHardwarePropertyDefaultSystemOutputDevice)
      AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &s, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &dev)
    }
  }

  static func volume(_ msg: [String: Any]) throws {
    let input = (msg["input"] as? Bool) ?? false
    let d = defaultDevice(input: input)
    guard d != 0 else { throw HelperError(message: input ? "No microphone" : "No sound output") }
    if let l = (msg["level"] as? NSNumber)?.doubleValue {
      if !setLevel(d, input: input, l) { throw HelperError(message: "This device’s volume can’t be changed by macOS (set it on the device)") }
      if !input, l > 0, muted(d, input: false) == true { _ = setMute(d, input: false, false) }
    }
    if let m = msg["mute"] as? Bool, !setMute(d, input: input, m) { throw HelperError(message: input ? "This microphone can’t be muted" : "This output can’t be muted") }
  }

  // MARK: Bluetooth
  @_silgen_name("IOBluetoothPreferenceGetControllerPowerState") private static func btPowerGet() -> Int32
  @_silgen_name("IOBluetoothPreferenceSetControllerPowerState") private static func btPowerSet(_ on: Int32)

  static func bt() -> [String: Any] {
    let paired = (IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice]) ?? []
    return [
      "radio": btPowerGet() != 0,
      "devices": paired.map { d -> [String: Any] in
        ["id": d.addressString ?? "", "name": d.name ?? d.addressString ?? "", "connected": d.isConnected(),
         "audio": d.deviceClassMajor == UInt32(kBluetoothDeviceClassMajorAudio)]
      },
    ]
  }

  static func btRadio(_ on: Bool) { btPowerSet(on ? 1 : 0) }

  static func btConnect(id: String, on: Bool) throws {
    guard let d = IOBluetoothDevice(addressString: id), d.isPaired() else { throw HelperError(message: "That Bluetooth device isn’t paired with this Mac") }
    if on {
      if btPowerGet() == 0 { btPowerSet(1); Thread.sleep(forTimeInterval: 1.5) }
      if !d.isConnected(), d.openConnection() != kIOReturnSuccess { throw HelperError(message: "\(d.name ?? "It") didn’t connect (is it on and nearby?)") }
    } else if d.isConnected() {
      d.closeConnection()
    }
  }

  // MARK: Brightness (DisplayServices, the framework System Settings' slider uses)
  private typealias GetB = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32
  private typealias SetB = @convention(c) (CGDirectDisplayID, Float) -> Int32
  private static let ds = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY)
  private static let getB: GetB? = ds.flatMap { dlsym($0, "DisplayServicesGetBrightness") }.map { unsafeBitCast($0, to: GetB.self) }
  private static let setB: SetB? = ds.flatMap { dlsym($0, "DisplayServicesSetBrightness") }.map { unsafeBitCast($0, to: SetB.self) }

  private static func onlineDisplays() -> [CGDirectDisplayID] {
    var n: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &n)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
    CGGetOnlineDisplayList(n, &ids, &n)
    return ids
  }

  static func bright() -> [String: Any] {
    var out: [[String: Any]] = []
    for id in onlineDisplays() where CGDisplayIsInMirrorSet(id) == 0 || CGDisplayIsMain(id) != 0 {
      var b: Float = -1
      guard let g = getB, g(id, &b) == 0, b >= 0 else { continue } // not one macOS dims (most third-party monitors)
      let name = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }?.localizedName
      out.append(["id": String(id), "name": name ?? (CGDisplayIsBuiltin(id) != 0 ? "Built-in display" : "Display"), "level": Double(b), "internal": CGDisplayIsBuiltin(id) != 0])
    }
    return ["displays": out]
  }

  static func setBright(id: String, level: Double) throws {
    guard let s = setB, let g = getB else { throw HelperError(message: "macOS doesn’t let apps change the brightness here") }
    var any = false
    for d in onlineDisplays() where id.isEmpty || String(d) == id {
      var b: Float = -1
      if g(d, &b) == 0, b >= 0, s(d, Float(max(0, min(1, level)))) == 0 { any = true }
    }
    if !any { throw HelperError(message: "macOS can’t change this display’s brightness (most monitors from other makers set it on the monitor)") }
  }

  // MARK: Windows (the Accessibility permission, asked the first time it's used)
  static func wins() -> [String: Any] {
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    let byPid = Dictionary(apps.map { (Int($0.processIdentifier), $0) }, uniquingKeysWith: { a, _ in a })
    let list = Apps.windows(pids: Set(byPid.keys)).map { w -> [String: Any] in
      var o = w
      let a = byPid[w["pid"] as? Int ?? 0]
      o["app"] = a?.localizedName ?? ""
      o["bundle"] = a?.bundleIdentifier ?? ""
      return o
    }
    return ["windows": list, "minimized": minimized(apps), "front": front().map { Int($0.0) } ?? 0]
  }

  // The regular apps' minimized windows (Accessibility only: without it, none): {wid, pid, app, bundle, title}.
  private static func minimized(_ apps: [NSRunningApplication]) -> [[String: Any]] {
    guard AXIsProcessTrusted() else { return [] }
    var out: [[String: Any]] = []
    for a in apps {
      for w in axAll(a.processIdentifier) {
        var m: CFTypeRef?, t: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &m) == .success, (m as? Bool) == true else { continue }
        var wid: CGWindowID = 0
        guard _AXUIElementGetWindow(w, &wid) == .success, wid != 0 else { continue }
        AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
        out.append(["wid": Int(wid), "pid": Int(a.processIdentifier), "app": a.localizedName ?? "", "bundle": a.bundleIdentifier ?? "", "title": t as? String ?? ""])
      }
    }
    return out
  }

  private static func axAll(_ pid: pid_t) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &v) == .success, let ws = v as? [AXUIElement] else { return [] }
    return ws
  }

  // A window by its id among every regular app's Accessibility windows (a minimized one isn't on screen).
  private static func axByWid(_ wid: Int) -> AXUIElement? {
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
      for w in axAll(a.processIdentifier) {
        var id: CGWindowID = 0
        if _AXUIElementGetWindow(w, &id) == .success, Int(id) == wid { return w }
      }
    }
    return nil
  }

  // The focused window of the app in front, with its CG window id when it's known.
  private static func front() -> (Int32, AXUIElement)? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &v) == .success, let w = v else { return nil }
    let win = w as! AXUIElement
    var wid: CGWindowID = 0
    _ = _AXUIElementGetWindow(win, &wid)
    return (Int32(wid), win)
  }

  private static func axWindow(_ wid: Int) throws -> AXUIElement {
    if !AXIsProcessTrusted() {
      AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
      throw HelperError(message: "Allow TwinDesk in Privacy & Security › Accessibility to move windows")
    }
    if wid == 0 { if let f = front() { return f.1 }; throw HelperError(message: "No window in front") }
    let all = Apps.windows(pids: Set(NSWorkspace.shared.runningApplications.map { Int($0.processIdentifier) }))
    guard let w = all.first(where: { ($0["wid"] as? Int) == wid }), let pid = w["pid"] as? Int else {
      if let m = axByWid(wid) { return m } // minimized
      throw HelperError(message: "That window is gone")
    }
    // Accessibility sees only this desktop's windows: one on another desktop or in full screen is still there.
    guard let ax = Apps.axWindow(pid: pid, frame: CGRect(x: w["x"] as? Double ?? 0, y: w["y"] as? Double ?? 0, width: w["w"] as? Double ?? 0, height: w["h"] as? Double ?? 0))
    else { throw HelperError(message: "That window is on another desktop or in full screen") }
    return ax
  }

  static func frame(wid: Int, _ r: CGRect) throws {
    let w = try axWindow(wid)
    var full: CFTypeRef?
    if AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &full) == .success, (full as? Bool) == true {
      AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, kCFBooleanFalse)
      Thread.sleep(forTimeInterval: 0.8)
    }
    AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    var p = r.origin, s = r.size
    // Position, size, then position again: a window too big for where it was is clamped by macOS.
    if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
    if let v = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
    if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    var pid: pid_t = 0
    AXUIElementGetPid(w, &pid)
    NSRunningApplication(processIdentifier: pid)?.activate()
  }

  static func op(wid: Int, _ op: String) throws {
    let w = try axWindow(wid)
    switch op {
    case "min": AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    case "restore":
      AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
      AXUIElementPerformAction(w, kAXRaiseAction as CFString)
      var pid: pid_t = 0
      AXUIElementGetPid(w, &pid)
      NSRunningApplication(processIdentifier: pid)?.activate()
    case "full":
      var v: CFTypeRef?
      AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &v)
      AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, ((v as? Bool) == true ? kCFBooleanFalse : kCFBooleanTrue) as CFTypeRef)
    case "close":
      var b: CFTypeRef?
      guard AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &b) == .success, let btn = b else { throw HelperError(message: "This window can’t be closed") }
      AXUIElementPerformAction(btn as! AXUIElement, kAXPressAction as CFString)
    default: throw HelperError(message: "Not a window action")
    }
  }

  // MARK: System
  private static func darkOn() -> Bool { UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["AppleInterfaceStyle"] as? String == "Dark" }

  static func sys(_ what: String) throws -> [String: Any] {
    switch what {
    case "sleep":
      let port = IOPMFindPowerManagement(mach_port_t(MACH_PORT_NULL))
      defer { IOServiceClose(port) }
      if IOPMSleepSystem(port) != kIOReturnSuccess { throw HelperError(message: "macOS didn’t go to sleep") }
    case "screenoff":
      let r = IORegistryEntryFromPath(kIOMainPortDefault, "IOService:/IOResources/IODisplayWrangler")
      defer { IOObjectRelease(r) }
      if r == 0 || IORegistryEntrySetCFProperty(r, "IORequestIdle" as CFString, kCFBooleanTrue) != kIOReturnSuccess { throw HelperError(message: "macOS didn’t turn the screens off") }
    case "lock":
      typealias Lock = @convention(c) () -> Void
      guard let h = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
            let f = dlsym(h, "SACLockScreenImmediate") else { throw HelperError(message: "macOS didn’t lock") }
      unsafeBitCast(f, to: Lock.self)()
    case "darkmode": // System Events' own switch (the Automation permission, asked the first time)
      let on = !darkOn()
      var err: NSDictionary?
      NSAppleScript(source: "tell application \"System Events\" to tell appearance preferences to set dark mode to \(on)")?.executeAndReturnError(&err)
      if err != nil { throw HelperError(message: "Allow TwinDesk to control System Events in Privacy & Security › Automation") }
      return ["on": on]
    case "desktop", "overview": // Mission Control: 1 shows the desktop, no argument shows every window
      let url = URL(fileURLWithPath: "/System/Applications/Mission Control.app")
      let cfg = NSWorkspace.OpenConfiguration()
      cfg.arguments = what == "desktop" ? ["1"] : []
      cfg.activates = false
      NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in }
    default: throw HelperError(message: "Not on this Mac")
    }
    return [:]
  }

  static func state() -> [String: Any] {
    var o: [String: Any] = ["dark": darkOn()]
    if let m = memUsed() { o["memUsed"] = m }
    if let t = temperature() { o["temp"] = t }
    return o
  }

  // MARK: Use and heat (the Deck's widgets)
  // Memory in use as Activity Monitor counts it: apps' memory, wired and compressed.
  private static func memUsed() -> Double? {
    var stats = vm_statistics64()
    var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
    let r = withUnsafeMutablePointer(to: &stats) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) } }
    guard r == KERN_SUCCESS else { return nil }
    let page = Double(vm_kernel_page_size)
    let used = (Double(stats.internal_page_count) - Double(stats.purgeable_count) + Double(stats.wire_count) + Double(stats.compressor_page_count)) * page
    let total = Double(ProcessInfo.processInfo.physicalMemory)
    return total > 0 ? max(0, min(1, used / total)) : nil
  }

  // The processor's temperature on Apple silicon: the hottest die sensor IOHID reports (Intel Macs
  // keep theirs in the SMC, not read here: nil).
  private static var hid: AnyObject?
  private static func temperature() -> Double? {
    if hid == nil {
      guard let c = IOHIDEventSystemClientCreate(kCFAllocatorDefault)?.takeRetainedValue() else { return nil }
      _ = IOHIDEventSystemClientSetMatching(c, ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 5] as CFDictionary)
      hid = c
    }
    guard let c = hid, let services = IOHIDEventSystemClientCopyServices(c)?.takeRetainedValue() as? [AnyObject] else { return nil }
    var die: [Double] = [], any: [Double] = []
    for sv in services {
      guard let ev = IOHIDServiceClientCopyEvent(sv, 15, 0, 0)?.takeRetainedValue() else { continue }
      let v = IOHIDEventGetFloatValue(ev, 15 << 16)
      guard v > 5, v < 130 else { continue }
      let prop: AnyObject? = IOHIDServiceClientCopyProperty(sv, "Product" as CFString)?.takeRetainedValue()
      let name = (prop as? String) ?? ""
      if name.contains("tdie") || name.contains("pACC") || name.contains("eACC") || name.contains("SOC") { die.append(v) } else { any.append(v) }
    }
    return (die.isEmpty ? any : die).max().map { ($0 * 10).rounded() / 10 }
  }

  static func handle(_ cmd: String, _ msg: [String: Any], _ id: Any?) {
    // Off the reading thread: Bluetooth and the window server can take a moment.
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        switch cmd {
        case "deckAudio": reply(id, audio())
        case "deckAudioDefault": try setDefault(uid: msg["dev"] as? String ?? "", input: (msg["input"] as? Bool) ?? false); reply(id)
        case "deckVolume": try volume(msg); reply(id)
        case "deckBt": reply(id, bt())
        case "deckBtRadio": btRadio((msg["on"] as? Bool) ?? true); reply(id)
        case "deckBtConnect": try btConnect(id: msg["dev"] as? String ?? "", on: (msg["on"] as? Bool) ?? true); reply(id)
        case "deckBright": reply(id, bright())
        case "deckBrightSet": try setBright(id: msg["dev"] as? String ?? "", level: (msg["level"] as? NSNumber)?.doubleValue ?? 0.5); reply(id)
        case "deckWins": reply(id, wins())
        case "deckWinFrame":
          let n = { (k: String) in (msg[k] as? NSNumber)?.doubleValue ?? 0 }
          try DispatchQueue.main.sync { try frame(wid: Int(n("wid")), CGRect(x: n("x"), y: n("y"), width: n("w"), height: n("h"))) }
          reply(id)
        case "deckWinOp": try DispatchQueue.main.sync { try op(wid: (msg["wid"] as? NSNumber)?.intValue ?? 0, msg["op"] as? String ?? "") }; reply(id)
        case "deckSys": reply(id, try DispatchQueue.main.sync { try sys(msg["what"] as? String ?? "") })
        case "deckState": reply(id, state())
        default: replyError(id, "unknown")
        }
      } catch let e as HelperError {
        replyError(id, e.message)
      } catch {
        replyError(id, error.localizedDescription)
      }
    }
  }
}

// IOHID's sensor services (the temperatures on Apple silicon), as Activity Monitor-like tools read them.
@_silgen_name("IOHIDEventSystemClientCreate") func IOHIDEventSystemClientCreate(_ a: CFAllocator?) -> Unmanaged<AnyObject>?
@_silgen_name("IOHIDEventSystemClientSetMatching") func IOHIDEventSystemClientSetMatching(_ c: AnyObject, _ m: CFDictionary) -> Int32
@_silgen_name("IOHIDEventSystemClientCopyServices") func IOHIDEventSystemClientCopyServices(_ c: AnyObject) -> Unmanaged<CFArray>?
@_silgen_name("IOHIDServiceClientCopyEvent") func IOHIDServiceClientCopyEvent(_ s: AnyObject, _ type: Int64, _ a: Int32, _ b: Int64) -> Unmanaged<AnyObject>?
@_silgen_name("IOHIDEventGetFloatValue") func IOHIDEventGetFloatValue(_ e: AnyObject, _ field: Int32) -> Double
@_silgen_name("IOHIDServiceClientCopyProperty") func IOHIDServiceClientCopyProperty(_ s: AnyObject, _ key: CFString) -> Unmanaged<AnyObject>?
@_silgen_name("_AXUIElementGetWindow") func _AXUIElementGetWindow(_ e: AXUIElement, _ wid: UnsafeMutablePointer<CGWindowID>) -> AXError
