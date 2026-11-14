// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone as the computer's remote (android/…/Remote.kt, shared/phone-remote.js there): the
// touchpad and keyboard, or the gamepad (remote.html), whose sticks and buttons press the computer's
// keys, or are a real controller there (Remote › Real gamepad on Windows and Linux: remote.pad).
// The computer moves its pointer and types while it lets this device control it (remote.state).
//
// And a real game controller (Xbox, PlayStation, MFi) connected to this iPhone: while it's on, its
// sticks and buttons go to the computer the same way: as a real controller where the computer has
// one, else as the gamepad's keys.
import Foundation
import GameController

final class Remote: Feature {
    private(set) var allowed: Bool?
    private(set) var why = ""
    private(set) var realPad = false // the computer takes remote.pad (its Real gamepad)
    private(set) var active = false
    private var host: WebHost?
    private var mode = "pad"
    private var controller: GCController?
    private var held = Set<String>() // keys the controller holds down there
    private var lastPad: JSON?
    private var lastPadAt = Date.distantPast

    // ---- settings ----
    var speed: Double { min(3, max(0.3, Double(core.store.string("remote.speed", "1.0")) ?? 1)) }
    func setSpeed(_ v: Double) { core.store.setString("remote.speed", String(format: "%.2f", v)); push() }
    var smooth: Bool { core.store.flag("remote.smooth", true) }
    func setSmooth(_ on: Bool) { core.store.setFlag("remote.smooth", on); push() }
    var tapClick: Bool { core.store.flag("remote.tapClick", true) }
    func setTapClick(_ on: Bool) { core.store.setFlag("remote.tapClick", on); push() }
    var controllerOn: Bool { core.store.flag("remote.controller", true) }
    func setControllerOn(_ on: Bool) { core.store.setFlag("remote.controller", on); watchControllers(); core.changed() }
    var controllerName: String? { controller?.vendorName ?? (controller != nil ? "Controller" : nil) }

    func padKey(_ id: String) -> String { (overrides()[id] as? String) ?? Self.defaults[id] ?? "" }
    func setPad(_ id: String, _ code: String) {
        guard Self.controls.contains(where: { $0.0 == id }), Self.keys.contains(where: { $0.0 == code }) else { return }
        var o = overrides()
        o[id] = code
        if let s = encodeJSON(o) { core.store.setString("remote.pad", s) }
        push()
    }
    func resetPad() { core.store.setString("remote.pad", "{}"); push() }
    private func overrides() -> JSON { decodeJSON(core.store.string("remote.pad", "{}")) ?? [:] }

    func layout() -> JSON { decodeJSON(core.store.string("remote.layout", "{}")) ?? [:] }
    func setLayout(_ json: String) {
        guard json.count <= 32_000, decodeJSON(json) != nil else { return }
        core.store.setString("remote.layout", json)
    }

    // A Bluetooth gamepad (Android's HID device profile) isn't something iOS lets an app be.
    func pad(b: Int, lx: Double, ly: Double, rx: Double, ry: Double, lt: Double, rt: Double) {}

    func opts() -> JSON {
        var pads: JSON = [:]
        for (id, _) in Self.controls { pads[id] = padKey(id) }
        return msg("opts", ["mode": mode, "name": core.host?.name ?? tr("the computer"), "me": core.store.deviceName, "connected": core.connected,
                            "os": core.host?.os ?? "", "ble": false, "speed": speed, "tap": tapClick, "smooth": smooth, "pad": pads,
                            "layout": layout(), "bt": false, "btName": "",
                            "controls": Self.controls.map { [$0.0, $0.1] }, "keys": Self.keys.map { [$0.0, $0.1] }])
    }

    private func push() {
        host?.post(opts())
        core.screen.repost()
        core.changed()
    }

    private func hello() { if core.connected { core.send(msg("remote.hello")) } }

    func attach(_ h: WebHost, mode: String) {
        host = h
        self.mode = mode
        active = true
        h.post(opts())
        if let a = allowed { h.post(msg("remote.state", ["allowed": a, "why": why, "pad": realPad])) }
        hello()
        core.changed()
    }

    func detach(_ h: WebHost) {
        guard host === h else { return }
        host = nil
        active = false
        if core.connected && controller == nil { core.send(msg("remote.release")) }
        core.changed()
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        allowed = nil
        self.host?.post(opts())
        if active || controller != nil { hello() }
        watchControllers()
    }

    override func onClosed() {
        allowed = nil
        realPad = false
        held.removeAll()
        host?.post(opts())
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == "remote.state" else { return false }
        allowed = m.bool("allowed")
        why = m.str("why")
        realPad = m.bool("pad")
        host?.post(m)
        core.changed()
        return true
    }

    // ---- a game controller on this iPhone ----

    private var watching = false

    func watchControllers() {
        if !watching {
            watching = true
            let nc = NotificationCenter.default
            nc.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] _ in self?.pickController() }
            nc.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] _ in self?.pickController() }
            GCController.shouldMonitorBackgroundEvents = true
        }
        pickController()
    }

    private func pickController() {
        let c = controllerOn ? GCController.controllers().first(where: { $0.extendedGamepad != nil }) : nil
        if c === controller { return }
        controller?.extendedGamepad?.valueChangedHandler = nil
        releaseHeld()
        controller = c
        if let g = c?.extendedGamepad {
            g.valueChangedHandler = { [weak self] gp, _ in self?.padChanged(gp) }
            hello()
        }
        core.changed()
    }

    private func padChanged(_ g: GCExtendedGamepad) {
        guard core.connected, allowed != false else { return }
        if realPad { return sendPad(g) }
        // As keys, the same as the gamepad page's: the left stick is four keys, the right moves the pointer.
        let lx = g.leftThumbstick.xAxis.value, ly = -g.leftThumbstick.yAxis.value
        let want: [String: Bool] = [
            "lsUp": ly < -0.5, "lsDown": ly > 0.5, "lsLeft": lx < -0.5, "lsRight": lx > 0.5,
            "a": g.buttonA.isPressed, "b": g.buttonB.isPressed, "x": g.buttonX.isPressed, "y": g.buttonY.isPressed,
            "lb": g.leftShoulder.isPressed, "rb": g.rightShoulder.isPressed, "lt": g.leftTrigger.value > 0.4, "rt": g.rightTrigger.value > 0.4,
            "up": g.dpad.up.isPressed, "down": g.dpad.down.isPressed, "left": g.dpad.left.isPressed, "right": g.dpad.right.isPressed,
            "back": g.buttonOptions?.isPressed ?? false, "start": g.buttonMenu.isPressed,
            "l3": g.leftThumbstickButton?.isPressed ?? false, "r3": g.rightThumbstickButton?.isPressed ?? false,
        ]
        for (id, on) in want {
            let code = padKey(id)
            guard !code.isEmpty else { continue }
            if on && !held.contains(id) { held.insert(id); press(code, true) }
            else if !on && held.contains(id) { held.remove(id); press(code, false) }
        }
        let rx = Double(g.rightThumbstick.xAxis.value), ry = Double(-g.rightThumbstick.yAxis.value)
        if abs(rx) > 0.15 || abs(ry) > 0.15 { startAim() }
    }

    private func press(_ code: String, _ down: Bool) {
        if code.hasPrefix("Mouse"), let b = Int(code.dropFirst(5)) { core.send(msg(down ? "remote.md" : "remote.mu", ["b": b])) }
        else { core.send(msg(down ? "remote.kd" : "remote.ku", ["code": code])) }
    }

    private func releaseHeld() {
        for id in held { let c = padKey(id); if !c.isEmpty { press(c, false) } }
        held.removeAll()
        if core.connected && controller != nil { core.send(msg("remote.release")) }
    }

    // The right stick moves the pointer, a frame at a time while it's off centre.
    private var aiming: Timer?
    private func startAim() {
        guard aiming == nil else { return }
        aiming = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] t in
            guard let self = self, let g = self.controller?.extendedGamepad, self.core.connected, !self.realPad else { t.invalidate(); self?.aiming = nil; return }
            let rx = Double(g.rightThumbstick.xAxis.value), ry = Double(-g.rightThumbstick.yAxis.value)
            if abs(rx) < 0.15 && abs(ry) < 0.15 { t.invalidate(); self.aiming = nil; return }
            let k = 18 * self.speed
            self.core.send(msg("remote.mm", ["dx": rx * abs(rx) * k, "dy": ry * abs(ry) * k, "smooth": true]))
        }
    }

    // As a real controller there: bits 0..13 A B X Y LB RB Back Start L3 R3 Up Down Left Right,
    // sticks −1…1 (y down), triggers 0…1; on change, at most every 8 ms.
    private func sendPad(_ g: GCExtendedGamepad) {
        let bits: [Bool] = [g.buttonA.isPressed, g.buttonB.isPressed, g.buttonX.isPressed, g.buttonY.isPressed,
                            g.leftShoulder.isPressed, g.rightShoulder.isPressed, g.buttonOptions?.isPressed ?? false, g.buttonMenu.isPressed,
                            g.leftThumbstickButton?.isPressed ?? false, g.rightThumbstickButton?.isPressed ?? false,
                            g.dpad.up.isPressed, g.dpad.down.isPressed, g.dpad.left.isPressed, g.dpad.right.isPressed]
        var b = 0
        for (i, on) in bits.enumerated() where on { b |= 1 << i }
        let r = { (v: Float) in (Double(v) * 1000).rounded() / 1000 }
        let m = msg("remote.pad", ["b": b, "lx": r(g.leftThumbstick.xAxis.value), "ly": r(-g.leftThumbstick.yAxis.value),
                                   "rx": r(g.rightThumbstick.xAxis.value), "ry": r(-g.rightThumbstick.yAxis.value),
                                   "lt": r(g.leftTrigger.value), "rt": r(g.rightTrigger.value)])
        if let l = lastPad, NSDictionary(dictionary: l).isEqual(to: m) { return }
        let now = Date()
        if now.timeIntervalSince(lastPadAt) < 0.008 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.008) { [weak self] in if let g = self?.controller?.extendedGamepad { self?.sendPad(g) } }
            return
        }
        lastPad = m
        lastPadAt = now
        core.send(m)
    }

    // ---- the gamepad page's controls and keys (Remote.kt) ----

    static var controls: [(String, String)] { [
        ("lsUp", tr("Left stick up")), ("lsLeft", tr("Left stick left")), ("lsDown", tr("Left stick down")), ("lsRight", tr("Left stick right")),
        ("l3", "L3"), ("r3", "R3"), ("a", "A"), ("b", "B"), ("x", "X"), ("y", "Y"),
        ("lb", "LB"), ("rb", "RB"), ("lt", "LT"), ("rt", "RT"),
        ("up", tr("D-pad up")), ("down", tr("D-pad down")), ("left", tr("D-pad left")), ("right", tr("D-pad right")),
        ("back", tr("gamepad|Back")), ("start", tr("gamepad|Start")),
    ] }

    static let defaults: [String: String] = [
        "lsUp": "KeyW", "lsLeft": "KeyA", "lsDown": "KeyS", "lsRight": "KeyD", "l3": "ShiftLeft", "r3": "KeyV",
        "a": "Space", "b": "ControlLeft", "x": "KeyR", "y": "KeyE", "lb": "KeyQ", "rb": "KeyF", "lt": "Mouse1", "rt": "Mouse0",
        "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight", "back": "Tab", "start": "Escape",
    ]

    static var keys: [(String, String)] {
        var k: [(String, String)] = [("", tr("Nothing")), ("Mouse0", tr("Left click")), ("Mouse1", tr("Right click")), ("Mouse2", tr("Middle click"))]
        for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" { k.append(("Key\(c)", String(c))) }
        for d in 0...9 { k.append(("Digit\(d)", "\(d)")) }
        k += [("Space", tr("Space")), ("Enter", "Enter"), ("Escape", "Esc"), ("Tab", "Tab"), ("Backspace", "Backspace"),
              ("ShiftLeft", "Shift"), ("ControlLeft", "Ctrl"), ("AltLeft", "Alt"),
              ("ArrowUp", tr("Up arrow")), ("ArrowDown", tr("Down arrow")), ("ArrowLeft", tr("Left arrow")), ("ArrowRight", tr("Right arrow")),
              ("Minus", "-"), ("Equal", "="), ("BracketLeft", "["), ("BracketRight", "]"), ("Semicolon", ";"), ("Quote", "'"),
              ("Comma", ","), ("Period", "."), ("Slash", "/"), ("Backquote", "`")]
        for f in 1...12 { k.append(("F\(f)", "F\(f)")) }
        k += [("Insert", "Insert"), ("Delete", "Delete"), ("Home", "Home"), ("End", "End"), ("PageUp", "Page Up"), ("PageDown", "Page Down")]
        return k
    }
}
