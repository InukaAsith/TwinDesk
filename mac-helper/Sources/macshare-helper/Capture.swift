// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Event tap for shared cursor/keyboard: edge push at home, Right-Option double-tap,
// capture (swallow + report as `ev`) per device class, dead-man, return edge while driven.
// Safety rules from Beamer's design: the callback only does cheap work and enqueues output; our
// own injections are skipped; the hotkey stops capture locally first; releases of keys pressed
// remotely are swallowed at home; no crossing during a drag.
import Cocoa

private let tapCallback: CGEventTapCallBack = { _, type, event, _ in
  Capture.shared.handle(type, event)
}

private func now() -> Double { ProcessInfo.processInfo.systemUptime }

// Hiding the pointer from a background process needs the window server's "SetsCursorInBackground"
// connection property (private; the same call Synergy/Barrier-style tools use).
@_silgen_name("_CGSDefaultConnection") private func _CGSDefaultConnection() -> Int32
@_silgen_name("CGSSetConnectionProperty")
private func CGSSetConnectionProperty(_ cid: Int32, _ target: Int32, _ key: CFString, _ value: CFTypeRef) -> CGError

/// The pointer is hidden on this Mac while it is on the other computer. Balanced: one hide, one show.
enum PointerVisibility {
  private static var hidden = false
  private static var allowed = false

  static func hide() {
    guard !hidden else { return }
    if !allowed {
      let cid = _CGSDefaultConnection()
      _ = CGSSetConnectionProperty(cid, cid, "SetsCursorInBackground" as CFString, kCFBooleanTrue)
      allowed = true
    }
    CGDisplayHideCursor(CGMainDisplayID())
    hidden = true
  }

  static func show() {
    guard hidden else { return }
    CGDisplayShowCursor(CGMainDisplayID())
    hidden = false
  }
}

final class Capture {
  static let shared = Capture()

  private var tap: CFMachPort?
  // kvmConfig. The parts inside #if MULTI are Multi-device's helper (macshare-helper-multi, built with
  // -D MULTI, docs/multi-device.md): several watched edges. The #else parts are the one-to-one helper's.
#if MULTI
  private var sides = ["right"]     // the edges watched (kvmConfig `sides`)
#else
  private var side = "right"
#endif
  private var resistance = 120.0
  private var edgeEnabled = false   // driveOther && mouse && link up (main decides)
  private var cfgKeyboard = true    // capture the keyboard when crossing at the edge
  private var dragFiles = true      // carry file drags across the edge (drag.policy, both sides)
  // capture
  private(set) var capturing = false
  private var capMouse = false, capKeyboard = false
  var gestures = true // Send trackpad gestures (k.ge) while capturing
  private var dock: (motion: Int64, progress: Double)? = nil // the dock swipe in progress
  private var pinnedAt: CGPoint?            // where the pointer stays (hidden) while it is on the other computer
  private var leftAt: CGPoint?              // where it left (pinnedAt moves with our own injected pointer)
  private var lastCommand = 0.0
  private var deadman: Timer?
#if MULTI
  // edge / return edge push, one state per side
  private var edgeBy: [String: (push: Double, at: Double, since: Double)] = [:]
  private var retBy: [String: (push: Double, at: Double, since: Double)] = [:]
  private var returnSides: [String] = []
#else
  // edge / return edge push
  private var edge = (push: 0.0, at: 0.0, since: 0.0)
  private var ret = (push: 0.0, at: 0.0, since: 0.0)
  private var returnSide: String?
#endif
  private var returnResistance = 120.0
  // Driven (armReturn on): the first input from this Mac's own mouse or trackpad takes the Mac back
  // (`local`): main sends the input home, so the driver gets its own pointer again where it left
  // and the two pointers stay apart. A move counts once it went `localPx` (not a resting palm), and
  // nothing counts in the first `localGrace` after the watch began.
  private var localWatch = false
  private var localSince = 0.0, localAt = 0.0, localAcc = 0.0
  private let localPx = 6.0, localGrace = 0.3
  // kvmConfig takeBack (off with Sync touchpads): our own input never takes the Mac back, the return
  // watch stays on and either mouse crosses.
  var takeBack = true {
    didSet { if !takeBack { localWatch = false } }
  }
  // Where along the side the other computer's monitors touch ours (shared/kvm-geom.js zones, 0–1 of
  // the bounding box, as `offset`): the edge and the way back only cross inside them. nil: anywhere.
  var edgeZones: [ClosedRange<Double>]?
  var returnZones: [ClosedRange<Double>]?
  // No new crossing within `cooldown` of the last one, either way (kvmConfig `cooldownMs`,
  // KVM_CROSS_COOLDOWN_MS). After arriving, the edge it came through only counts once the pointer
  // moved 8 pt inward or `guardWindow` passed, so the end of a flick doesn't bounce straight back.
  private var cooldown = 0.25
  private let guardWindow = 0.5
  // A push crosses once it went `resistance` outward and lasted `dwell` (kvmConfig `dwellMs`,
  // KVM_EDGE_DWELL_MS; none with no resistance): the end of a quick flick that reaches the edge
  // is over by then, a push meant to cross goes on.
  var dwell = 0.15
  private var lastCross = 0.0
  private var arrival: (side: String, at: Double, inward: Double)?
  private var dragPbCount = -1             // drag pasteboard changeCount when the left button went down
  // hotkey: a right-hand modifier, double-tapped (kvmConfig `hotkey`; default Right Option, kVK 0x3D, device flag 0x40)
  private var hkStage = 0, hkAt = 0.0
  private var hkKeys: [UInt16: UInt64] = [0x3D: 0x40] // keycode -> device flag ("Alt" = both Option keys)
  // While capturing, a hotkey press waits: sent (k.kd) only if another key or a click follows, so
  // shortcuts with it work on the other computer and a plain tap never reaches it.
  private var hkPending: UInt16?
  // keys
  private var remoteDown = Set<UInt16>()  // pressed while capturing (went to the other machine)
  private var swallowUps = Set<UInt16>()  // their releases, to swallow at home
  private var localDown = Set<UInt16>()   // pressed at home (their releases stay local)

  /// Any command from main counts as a keepalive.
  func touch() { lastCommand = now() }

  func startTap() -> Bool {
    if tap != nil { return true }
    let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged,
                                .otherMouseDragged, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
    var mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    for raw in Capture.gestureTypes { mask |= CGEventMask(1) << CGEventMask(raw) } // trackpad gestures
    mask |= CGEventMask(1) << CGEventMask(Capture.systemDefined) // volume, brightness, media keys
    guard let t = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                    eventsOfInterest: mask, callback: tapCallback, userInfo: nil) else {
      log("event tap failed: Accessibility / Input Monitoring not granted?")
      return false
    }
    tap = t
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, t, 0), .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    log("event tap on")
    return true
  }

#if MULTI
  func configure(sides: [String], resistance: Double, edgeEnabled: Bool, keyboard: Bool, dragFiles: Bool, hotkey: String, cooldown: Double) {
    // "AltRight", "AltLeft" or "Alt" (either side); same for Control, Shift, Meta.
    let names = ["Alt", "Control", "Shift", "Meta"].contains(hotkey) ? [hotkey + "Left", hotkey + "Right"] : [hotkey]
    var keys: [UInt16: UInt64] = [:]
    for n in names { if let kc = KeyCodes.toMac[n], let m = KeyCodes.modifiers[n] { keys[kc] = m.device } }
    if !keys.isEmpty && keys != hkKeys {
      hkKeys = keys
      hkStage = 0
      hkPending = nil
    }
    self.dragFiles = dragFiles
    self.sides = sides
    self.resistance = resistance
    self.edgeEnabled = edgeEnabled
    self.cfgKeyboard = keyboard
    self.cooldown = cooldown
    edgeBy.removeAll()
  }
#else
  func configure(side: String, resistance: Double, edgeEnabled: Bool, keyboard: Bool, dragFiles: Bool, hotkey: String, cooldown: Double) {
    // "AltRight", "AltLeft" or "Alt" (either side); same for Control, Shift, Meta.
    let names = ["Alt", "Control", "Shift", "Meta"].contains(hotkey) ? [hotkey + "Left", hotkey + "Right"] : [hotkey]
    var keys: [UInt16: UInt64] = [:]
    for n in names { if let kc = KeyCodes.toMac[n], let m = KeyCodes.modifiers[n] { keys[kc] = m.device } }
    if !keys.isEmpty && keys != hkKeys {
      hkKeys = keys
      hkStage = 0
      hkPending = nil
    }
    self.dragFiles = dragFiles
    self.side = side
    self.resistance = resistance
    self.edgeEnabled = edgeEnabled
    self.cfgKeyboard = keyboard
    self.cooldown = cooldown
    edge.push = 0
  }
#endif

  // MARK: capture

  func startCapture(mouse: Bool, keyboard: Bool) {
    if capturing { stopCapture(side: nil, offset: nil) }
    capturing = true
    capMouse = mouse
    capKeyboard = keyboard
    lastCross = now()
    arrival = nil
    if mouse {
      CGAssociateMouseAndMouseCursorPosition(0) // pointer frozen, deltas still arrive
      pinnedAt = CGEvent(source: nil)?.location
      leftAt = pinnedAt
      // Hide it once the leaving animation and a drag hand-off at the edge had their moment.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
        if let self = self, self.capturing, self.capMouse { PointerVisibility.hide() }
      }
    }
    touch()
    deadman?.invalidate()
    deadman = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      guard let self = self, self.capturing, now() - self.lastCommand > 1.5 else { return }
      self.stopCapture(side: nil, offset: nil)
      emit(["event": "captureEnded", "reason": "deadman"])
    }
  }

  func stopCapture(side: String?, offset: Double?) {
    guard capturing else { return }
    capturing = false
    hkPending = nil
    deadman?.invalidate()
    deadman = nil
    if capMouse { CGAssociateMouseAndMouseCursorPosition(1) }
    var moved: CGPoint? = nil // our injected pointer moved the pin: where it left
    if let p = pinnedAt, let l = leftAt, abs(p.x - l.x) > 0.5 || abs(p.y - l.y) > 0.5 { moved = l }
    pinnedAt = nil
    leftAt = nil
    PointerVisibility.show()
    if let side = side, let offset = offset {
      let p = Screens.edgePoint(side: side, offset: offset)
      warp(p)
      Flash.shared.arrive(at: p, side: side) // back on this Mac
    } else if let back = moved {
      warp(back) // our injected pointer moved it (a moved window used over there): back where it left
      Flash.shared.arrive(at: back, side: nil)
    } else {
      Flash.shared.arrive(at: CGEvent(source: nil)?.location ?? .zero, side: nil)
    }
    swallowUps.formUnion(remoteDown)
    remoteDown.removeAll()
    arrived(side: side)
  }

  /// Our own injected pointer (a window moved to the other computer, used from its copy there while
  /// this Mac drives it) put the hidden pointer at `p`: it stays there, not warped back to the pin.
  /// Warping back fought every injected move, and each warp held the mouse still for a moment, so
  /// this Mac's pointer couldn't get into that copy.
  func injectedPointer(at p: CGPoint) {
    if capturing && capMouse && pinnedAt != nil { pinnedAt = p }
  }

  /// The pointer came to this computer (back home, or placed by the driver) through `side`, or by
  /// the hotkey (nil). Starts the cooldown and the arrival guard, and clears every push.
  func arrived(side: String?) {
    lastCross = now()
    arrival = side.map { (side: $0, at: lastCross, inward: 0.0) }
#if MULTI
    edgeBy.removeAll()
    retBy.removeAll()
#else
    edge.push = 0
    ret.push = 0
#endif
  }

  /// The sides where an injected move must stop at the edge rather than jump onto a display past it.
  /// Read for every injected move: the same array until the side changes, never a new one per move.
#if !MULTI
  private var stopsSide: String?
  private var stopsKnown = false
  private var stopsList: [String] = []
#endif
  var returnStops: [String] {
#if MULTI
    return returnSides
#else
    if !stopsKnown || stopsSide != returnSide {
      stopsKnown = true
      stopsSide = returnSide
      stopsList = returnSide.map { [$0] } ?? []
    }
    return stopsList
#endif
  }

  func warp(_ p: CGPoint) {
    CGWarpMouseCursorPosition(p)
    CGAssociateMouseAndMouseCursorPosition(1) // also ends the ~0.25 s local-event suppression after a warp
  }

#if MULTI
  func armReturn(on: Bool, sides: [String], resistance: Double) {
    watchLocal(on)
    returnSides = on ? sides : []
    returnResistance = resistance
    retBy.removeAll()
  }

  /// Return-edge check while driven; called for local moves and for injected relative moves.
  /// Any armed side counts: the way back to the driver, or an edge that leads on to another device.
  func checkReturn(_ p: CGPoint, dx: Double, dy: Double) {
    guard !returnSides.isEmpty else { return }
    var hit: (side: String, offset: Double)? = nil
    for side in returnSides {
      var st = retBy[side] ?? (push: 0.0, at: 0.0, since: 0.0)
      let off = push(&st, p, dx, dy, side, returnResistance, returnZones)
      retBy[side] = st
      if hit == nil, let off = off { hit = (side: side, offset: off) }
    }
    guard let found = hit else { return }
    returnSides = []
    lastCross = now()
    Flash.shared.leave(at: p, side: found.side)
    var out: [String: Any] = ["event": "return", "side": found.side, "offset": found.offset]
    if let d = returnDrag(at: p) { out["drag"] = d }
    let moving = WindowGrab.shared.take(keepUp: false)
    if moving != 0 { out["moving"] = moving; out["movingPid"] = WindowGrab.shared.pid } // a grabbed window goes along
    emit(out)
  }

  /// The first watched edge the pointer pushed through (its side and offset), if any.
  private func edgeCrossing(_ p: CGPoint, dx: Double, dy: Double) -> (side: String, offset: Double)? {
    var hit: (side: String, offset: Double)? = nil
    for side in sides {
      var st = edgeBy[side] ?? (push: 0.0, at: 0.0, since: 0.0)
      let off = push(&st, p, dx, dy, side, resistance, edgeZones)
      edgeBy[side] = st
      if hit == nil, let off = off { hit = (side: side, offset: off) }
    }
    return hit
  }
#else
  func armReturn(on: Bool, side: String, resistance: Double) {
    watchLocal(on)
    returnSide = on ? side : nil
    returnResistance = resistance
    ret.push = 0
  }

  /// Return-edge check while driven; called for local moves and for injected relative moves.
  func checkReturn(_ p: CGPoint, dx: Double, dy: Double) {
    guard let side = returnSide, let off = push(&ret, p, dx, dy, side, returnResistance, returnZones) else { return }
    returnSide = nil
    lastCross = now()
    Flash.shared.leave(at: p, side: side)
    var out: [String: Any] = ["event": "return", "offset": off]
    if let d = returnDrag(at: p) { out["drag"] = d }
    let moving = WindowGrab.shared.take(keepUp: false)
    if moving != 0 { out["moving"] = moving; out["movingPid"] = WindowGrab.shared.pid } // a grabbed window goes along
    emit(out)
  }
#endif

  private func watchLocal(_ on: Bool) {
    localWatch = on && takeBack
    localSince = now()
    localAcc = 0
  }

  /// This Mac's own mouse or trackpad while driven (injected events never get here): true once it
  /// takes the Mac back. The return watch stops with it, so this same motion can't send a `return`.
  private func noteLocal(_ type: CGEventType, _ dx: Double, _ dy: Double) -> Bool {
    guard localWatch, !capturing else { return false }
    let down = type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown
    let moved = type == .mouseMoved || type == .leftMouseDragged || type == .rightMouseDragged || type == .otherMouseDragged
    guard down || moved else { return false }
    let t = now()
    if t - localSince < localGrace { return false }
    if moved {
      if t - localAt > 0.3 { localAcc = 0 }
      localAt = t
      localAcc += abs(dx) + abs(dy)
      if localAcc < localPx { return false }
    }
    localWatch = false
#if MULTI
    returnSides = []
#else
    returnSide = nil
#endif
    emit(["event": "local"])
    return true
  }

  /// The driver's left button still held in a file drag as the pointer goes back: it carries on
  /// there. Our drag in from it (DragIn) comes back (`back`: main cancels it here); a Finder drag
  /// ends on a catcher here and its files go over (`paths`).
  private func returnDrag(at p: CGPoint) -> [String: Any]? {
    guard injector.heldButtons.contains(0) else { return nil }
    if DragIn.shared.active { return ["back": true] }
    guard dragFiles else { return nil }
    let paths = draggedFiles()
    guard !paths.isEmpty else { return nil }
    injector.heldButtons.remove(0) // the catcher's button-up releases it
    DragIn.shared.swallowLocalDrag(at: p)
    log("return: drag through the edge, \(paths.count) file(s) on the drag pasteboard")
    return ["paths": paths]
  }

  /// The driver pressed the left button here (injected, so the tap doesn't see it): a drag that
  /// starts now is a new one (draggedFiles).
  func injectedLeftDown() {
    dragPbCount = NSPasteboard(name: .drag).changeCount
  }

  /// Accumulate outward motion on an outer edge; returns the offset when it went through.
  private func push(_ st: inout (push: Double, at: Double, since: Double), _ p: CGPoint, _ dx: Double, _ dy: Double,
                    _ side: String, _ resistance: Double, _ zones: [ClosedRange<Double>]?) -> Double? {
    let out = side == "right" ? dx : side == "left" ? -dx : side == "bottom" ? dy : -dy
    let t = now()
    if t - st.at > 0.3 { st.push = 0 }
    if t - lastCross < cooldown {
      st.push = 0
      return nil
    }
    if var a = arrival, a.side == side {
      if out < 0 { a.inward -= out }
      if t - a.at < guardWindow && a.inward < 8 {
        arrival = a
        st.push = 0
        return nil
      }
      arrival = nil
    }
    guard out > 0, Screens.isOuterEdge(p, side: side),
          zones.map({ z in z.contains { $0.contains(Screens.offset(p, side: side)) } }) ?? true else {
      st.push = 0
      return nil
    }
    if st.push == 0 { st.since = t }
    st.push += out
    st.at = t
    guard st.push >= resistance, resistance <= 0 || t - st.since >= dwell else { return nil }
    st.push = 0
    return Screens.offset(p, side: side)
  }

  // MARK: tap callback

  func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    let pass = Unmanaged.passUnretained(event)
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
      return pass
    }
    if event.getIntegerValueField(.eventSourceUserData) == injectedMark { return pass }
    if Capture.gestureTypes.contains(type.rawValue) { return onGesture(event) ? nil : pass }
    if type.rawValue == Capture.systemDefined { return onSystemKey(event) ? nil : pass }
    switch type {
    case .flagsChanged: return onFlags(event) ? nil : pass
    case .keyDown, .keyUp: return onKey(event, down: type == .keyDown) ? nil : pass
    default: return onMouse(type, event) ? nil : pass
    }
  }

  private func ev(_ fields: [String: Any]) {
#if TDFAST
    var f = fields
    NativeLane.shared.fence(&f) // a click, key, wheel or gesture: its event number and fence (Lane.swift)
    emit(["event": "ev", "ev": f])
#else
    emit(["event": "ev", "ev": fields])
#endif
  }

  /// Returns true to swallow.
  private func onFlags(_ e: CGEvent) -> Bool {
    let kc = UInt16(e.getIntegerValueField(.keyboardEventKeycode))
    let flags = e.flags.rawValue
    if let dev = hkKeys[kc] { // the hotkey
      let down = flags & dev != 0
      if hotkeyStep(down: down) {
        hkPending = nil
        if capturing {
          stopCapture(side: nil, offset: nil) // stop locally first, even if main is stuck
          emit(["event": "hotkey", "local": true])
          return true
        }
        emit(["event": "hotkey"])
      }
      guard capturing && capKeyboard, let code = KeyCodes.code(kc, kbType: e.getIntegerValueField(.keyboardEventKeyboardType)) else {
        if down { localDown.insert(kc) } else { localDown.remove(kc); swallowUps.remove(kc) }
        return false
      }
      if down {
        hkPending = kc // wait: a shortcut sends it, a tap doesn't
      } else if localDown.remove(kc) != nil {
        return false // pressed at home: release at home
      } else if remoteDown.remove(kc) != nil {
        ev(["t": "k.ku", "code": code])
      } else if hkPending == kc {
        hkPending = nil
      }
      return true
    }
    hkStage = 0
    flushHotkey()
    guard let code = KeyCodes.code(kc, kbType: e.getIntegerValueField(.keyboardEventKeyboardType)) else { return capturing && capKeyboard }
    if kc == 0x39 { // Caps Lock toggles: send a full press
      if capturing && capKeyboard { ev(["t": "k.kd", "code": code]); ev(["t": "k.ku", "code": code]); return true }
      return false
    }
    if code == "Fn" { // 🌐: the other computer switches its layout on a tap of it (Inject.key)
      guard capturing && capKeyboard else { return false }
      ev(["t": e.flags.contains(.maskSecondaryFn) ? "k.kd" : "k.ku", "code": code])
      return true
    }
    guard let m = KeyCodes.modifiers[code] else { return capturing && capKeyboard }
    let down = flags & m.device != 0
    if capturing && capKeyboard {
      if !down && localDown.remove(kc) != nil { return false } // pressed at home: release at home
      if down { remoteDown.insert(kc) } else { remoteDown.remove(kc) }
      ev(["t": down ? "k.kd" : "k.ku", "code": code])
      return true
    }
    if down { localDown.insert(kc) } else { localDown.remove(kc); swallowUps.remove(kc) }
    return false
  }

  // Trackpad gestures. Event types outside CGEventType: 18 rotate, 19/20 begin/end
  // gesture, 29 gesture (pinch, smart zoom, swipe), 30 dock control (the system's 3/4-finger swipes
  // and pinches: Mission Control, Spaces, App Exposé, Launchpad, Show Desktop), 31 swipe, 32 smart zoom.
  static let gestureTypes: Set<UInt32> = [18, 19, 20, 29, 30, 31, 32]
  static let systemDefined: UInt32 = 14 // NX_SYSDEFINED
  // Private gesture fields (as WindowServer fills them for dock swipes).
  private static let fHidType = CGEventField(rawValue: 110)!, fMotion = CGEventField(rawValue: 123)!,
    fProgress = CGEventField(rawValue: 124)!, fPhase = CGEventField(rawValue: 132)!, fExit = CGEventField(rawValue: 129)!

  /// While capturing: send what the gesture means (k.ge) and swallow it, so it doesn't also act on
  /// this Mac. At home: pass it through.
  private func onGesture(_ e: CGEvent) -> Bool {
    guard capturing && capMouse else { return false }
    guard gestures else { return true }
    if e.getIntegerValueField(Capture.fHidType) == 23 { // dock swipe
      // Streamed as it happens (a Mac on the other side replays it, so Spaces and Mission Control
      // follow the fingers); the end also says what it meant, for a PC (`mean`).
      let ph = e.getIntegerValueField(Capture.fPhase) // 1 began, 2 changed, 4 ended, 8 cancelled
      let motion = e.getIntegerValueField(Capture.fMotion) // 1 horizontal, 2 vertical, 3/4 pinch
      let progress = e.getDoubleValueField(Capture.fProgress)
      if ph == 1 || dock == nil { dock = (motion, 0) }
      let m = dock?.motion ?? motion
      var out: [String: Any] = ["t": "k.ge", "g": "dock", "motion": m, "v": progress,
                                "phase": ph == 1 ? "begin" : ph == 4 ? "end" : ph == 8 ? "cancel" : "change"]
      if ph == 1 || ph == 2 { dock = (m, progress) }
      if ph == 4 || ph == 8 {
        let p = ph == 4 ? progress : 0
        out["exit"] = e.getDoubleValueField(Capture.fExit)
        if ProcessInfo.processInfo.environment["MACSHARE_DEBUG_GESTURES"] != nil { log("dock swipe motion \(m) progress \(p)") }
        if abs(p) > 0.1 {
          out["mean"] = m == 1 ? (p < 0 ? "spaceLeft" : "spaceRight") // sign swapped: the PC went the wrong way
            : m == 2 ? (p < 0 ? "overview" : "appWindows") // up: Mission Control; down: App Exposé
            : (p < 0 ? "launcher" : "desktop") // pinch in: Launchpad; spread: desktop
        }
        dock = nil
      }
      ev(out)
      return true
    }
    guard let n = NSEvent(cgEvent: e) else { return true }
    let phase = n.phase.contains(.began) ? "begin" : n.phase.contains(.ended) || n.phase.contains(.cancelled) ? "end" : "change"
    switch n.type {
    case .magnify: ev(["t": "k.ge", "g": "zoom", "v": Double(n.magnification), "phase": phase])
    case .smartMagnify: ev(["t": "k.ge", "g": "smartZoom"])
    case .rotate: ev(["t": "k.ge", "g": "rotate", "v": Double(n.rotation), "phase": phase])
    case .swipe: if n.deltaX != 0 { ev(["t": "k.ge", "g": n.deltaX > 0 ? "back" : "forward"]) }
    default: break
    }
    return true
  }

  /// The held hotkey turned out to be part of a shortcut: send its press now, before the key.
  private func flushHotkey() {
    guard let kc = hkPending, capturing && capKeyboard, let code = KeyCodes.code(kc) else { hkPending = nil; return }
    hkPending = nil
    remoteDown.insert(kc)
    ev(["t": "k.kd", "code": code])
  }

  private func onKey(_ e: CGEvent, down: Bool) -> Bool {
    hkStage = 0
    if down { flushHotkey() }
    let kc = UInt16(e.getIntegerValueField(.keyboardEventKeycode))
    if capturing && capKeyboard {
      if !down && localDown.remove(kc) != nil { return false }
      guard let code = KeyCodes.code(kc, kbType: e.getIntegerValueField(.keyboardEventKeyboardType)) else { return true }
      if down { remoteDown.insert(kc) } else { remoteDown.remove(kc) }
      ev(["t": down ? "k.kd" : "k.ku", "code": code])
      return true
    }
    if !down && swallowUps.remove(kc) != nil { return true } // pressed on the other machine
    if down { localDown.insert(kc) } else { localDown.remove(kc) }
    return false
  }

  // Volume, brightness and media keys (NX_SYSDEFINED, subtype 8): to the other computer while the
  // keyboard is there, as k.kd / k.ku with their codes (KeyCodes.system). Anything else stays here.
  private func onSystemKey(_ e: CGEvent) -> Bool {
    guard capturing && capKeyboard, let ns = NSEvent(cgEvent: e), ns.subtype.rawValue == 8 else { return false }
    let d = ns.data1
    guard let code = KeyCodes.fromSystem[(d & 0xFFFF0000) >> 16] else { return false }
    let state = (d & 0xFF00) >> 8 // 0x0A down, 0x0B up
    guard state == 0x0A || state == 0x0B else { return false }
    hkStage = 0
    ev(["t": state == 0x0A ? "k.kd" : "k.ku", "code": code])
    return true
  }

  private func onMouse(_ type: CGEventType, _ e: CGEvent) -> Bool {
    var type = type
    let dx = e.getDoubleValueField(.mouseEventDeltaX), dy = e.getDoubleValueField(.mouseEventDeltaY)
    // Move windows (Grab.swift): the move key and a click grab a window, never while capturing.
    let grab = WindowGrab.shared
    if type == .leftMouseUp && grab.upPending { _ = grab.up(); return true }
    if !capturing {
      if type == .leftMouseDown && grab.tryGrab(at: e.location, flags: e.flags.rawValue) { return true }
      if grab.grabbing && type == .leftMouseDragged { e.type = .mouseMoved; type = .mouseMoved } // the system never saw the press
      if grab.grabbing && type == .mouseMoved { grab.move(to: e.location) }
    }
    let isDown = type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown
    let isUp = type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp
    if isDown {
      hkStage = 0
      flushHotkey() // Ctrl/⌘-click with the hotkey key
    }

    if capturing && capMouse {
      // Keep the hidden pointer where it left, even if the freeze lapsed (it moved on its own before).
      if let pin = pinnedAt, abs(e.location.x - pin.x) > 0.5 || abs(e.location.y - pin.y) > 0.5 {
        CGWarpMouseCursorPosition(pin)
        CGAssociateMouseAndMouseCursorPosition(0)
      }
      if isDown || isUp {
        let b = type == .leftMouseDown || type == .leftMouseUp ? 0
          : type == .rightMouseDown || type == .rightMouseUp ? 1 : Int(e.getIntegerValueField(.mouseEventButtonNumber))
        ev(["t": isDown ? "k.md" : "k.mu", "b": b])
      } else if type == .scrollWheel {
        if e.getIntegerValueField(.scrollWheelEventIsContinuous) != 0 {
          ev(["t": "k.wh", "mode": "pixel",
              "dx": -e.getDoubleValueField(.scrollWheelEventPointDeltaAxis2),
              "dy": -e.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)])
        } else {
          ev(["t": "k.wh", "mode": "line",
              "dx": -e.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2),
              "dy": -e.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1)])
        }
      } else if dx != 0 || dy != 0 {
#if TDFAST
        if let m = NativeLane.shared.move(dx, dy) { ev(m) } // nil: it went on the input lane (Lane.swift)
#else
        ev(["t": "k.mm", "dx": dx, "dy": dy])
#endif
        Shake.feed(dx, dy) // after it went: shaken, the pointer comes home (Shake.swift)
      }
      return true
    }

    if noteLocal(type, dx, dy) { return false } // ours again: the event goes on here as it is
    if type == .leftMouseDown { dragPbCount = NSPasteboard(name: .drag).changeCount }
    // A file drag pushed through the crossing edge carries the files over.
#if MULTI
    if type == .leftMouseDragged, !capturing, edgeEnabled, dragFiles,
       let hit = edgeCrossing(e.location, dx: dx, dy: dy) {
      let paths = draggedFiles()
      log("edge: drag through the edge, \(paths.count) file(s) on the drag pasteboard")
      if !paths.isEmpty {
        startCapture(mouse: true, keyboard: cfgKeyboard)
        DragIn.shared.swallowLocalDrag(at: e.location) // Finder's drag ends here, quietly
        Flash.shared.leave(at: e.location, side: hit.side)
        emit(["event": "edge", "side": hit.side, "offset": hit.offset, "drag": ["paths": paths]])
        return true
      }
    }
#else
    if type == .leftMouseDragged, !capturing, edgeEnabled, dragFiles,
       let off = push(&edge, e.location, dx, dy, side, resistance, edgeZones) {
      let paths = draggedFiles()
      log("edge: drag through the edge, \(paths.count) file(s) on the drag pasteboard")
      if !paths.isEmpty {
        startCapture(mouse: true, keyboard: cfgKeyboard)
        DragIn.shared.swallowLocalDrag(at: e.location) // Finder's drag ends here, quietly
        Flash.shared.leave(at: e.location, side: side)
        emit(["event": "edge", "offset": off, "drag": ["paths": paths]])
        return true
      }
    }
#endif
    if type == .mouseMoved {
      // The system's own button state: counting downs and ups here stuck at 1 when the tap missed
      // an up (disabled by a timeout meanwhile), and nothing crossed again until a restart.
#if MULTI
      if !capturing, edgeEnabled, NSEvent.pressedMouseButtons == 0 || grab.grabbing,
         let hit = edgeCrossing(e.location, dx: dx, dy: dy) {
        startCapture(mouse: true, keyboard: cfgKeyboard) // capture first, so no motion leaks
        Flash.shared.leave(at: e.location, side: hit.side)
        var out: [String: Any] = ["event": "edge", "side": hit.side, "offset": hit.offset]
        let moving = grab.take(keepUp: true)
        if moving != 0 { out["moving"] = moving; out["movingPid"] = WindowGrab.shared.pid } // a grabbed window goes along
        emit(out)
        return true
      }
#else
      if !capturing, edgeEnabled, NSEvent.pressedMouseButtons == 0 || grab.grabbing,
         let off = push(&edge, e.location, dx, dy, side, resistance, edgeZones) {
        startCapture(mouse: true, keyboard: cfgKeyboard) // capture first, so no motion leaks
        Flash.shared.leave(at: e.location, side: side)
        var out: [String: Any] = ["event": "edge", "offset": off]
        let moving = grab.take(keepUp: true)
        if moving != 0 { out["moving"] = moving; out["movingPid"] = WindowGrab.shared.pid } // a grabbed window goes along
        emit(out)
        return true
      }
#endif
      checkReturn(e.location, dx: dx, dy: dy)
    }
    return false
  }

  /// Files on the drag pasteboard, if a drag started since the left button went down.
  private func draggedFiles() -> [String] {
    let pb = NSPasteboard(name: .drag)
    guard pb.changeCount != dragPbCount else { return [] }
    let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    return urls.map { $0.path }
  }

  /// Double-tap: down, up, down, up — each step within the double-tap window.
  private func hotkeyStep(down: Bool) -> Bool {
    let t = now(), win = 0.4
    switch hkStage {
    case 0: if down { hkStage = 1; hkAt = t }
    case 1: if !down { hkStage = t - hkAt < win ? 2 : 0; hkAt = t }
    case 2: if down { if t - hkAt < win { hkStage = 3 } else { hkStage = 1 }; hkAt = t }
    case 3:
      if !down {
        hkStage = 0
        return t - hkAt < win
      }
    default: hkStage = 0
    }
    return false
  }
}
