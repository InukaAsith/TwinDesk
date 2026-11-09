// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer's screen here (Receive screen), as android/…/Web.kt's Screen: what it shares
// (screen.state), Start/Stop and Mirror/Extend (screen.ctl), and the viewer page while it's open
// (screen.policy {accept, width, height} tells the computer to stream, sized for Extend). The
// picture comes as WebRTC (rtc.offer/ice into viewer.html); touches, the Pencil, a mouse or
// trackpad and the keyboard go back as in.*. On the USB cable the computer adds its relay (TURN).
//
// And the computer's sound here (audio m2w) without the screen: audio.html in a hidden page.
import Foundation
import UIKit

final class Screen: Feature {
    private(set) var state: JSON? // the computer's screen.state
    private(set) var inputOn = true
    private(set) var viewing = false
    private(set) var size: (Int, Int)?
    private(set) var autoOpened = false
    private var host: WebHost?
    private var lastInfo: JSON?
    private var wantStart = false
    private var startedByUs = false
    // The computer started sharing by itself while we're in front: the page opens the viewer.
    var autoOpen = false

    var sharing: Bool { (state?["on"] as? Bool) == true }
    var mode: String { state?.str("mode") ?? "" }
    var remote: Bool { (state?["remote"] as? Bool) ?? true }
    var modes: [String] { (state?["modes"] as? [String]) ?? ["mirror", "extend"] }

    // ---- options (General › Receive screen, and the viewer's bar) ----
    var touchpad: Bool { core.store.flag("screen.touchpad", false) } // off: touch screen (the pointer is where the finger is)
    var sound: Bool { core.store.flag("screen.sound", false) }
    var smooth: Bool { core.store.flag("screen.smooth", false) }
    var pen: Bool { core.store.flag("screen.pen", true) }
    var penFast: Bool { core.store.flag("screen.penFast", false) } // Fast writing: the Pencil's samples batched (viewer.js)

    func setOpt(_ key: String, _ on: Bool) {
        core.store.setFlag(key, on)
        host?.post(opts())
        core.changed()
    }

    func opts() -> JSON {
        msg("opts", ["sound": sound, "pacing": smooth ? "smooth" : "fast", "name": core.host?.name ?? tr("the computer"),
                     "touch": touchpad ? "pad" : "direct", "speed": core.remote.speed, "tap": core.remote.tapClick, "pen": pen, "penFast": penFast])
    }

    func repost() { host?.post(opts()) }

    // The viewer opened: stream to us at this screen's size in pixels, held landscape (the computer
    // makes Extend this shape).
    func attach(_ h: WebHost) {
        host = h
        viewing = true
        h.onEvent = { [weak self] ev, data in
            if ev == "playing", let d = data { self?.size = (d.int("w"), d.int("h")); self?.core.changed() }
        }
        h.post(opts())
        if let i = lastInfo { h.post(i) }
        if let s = state { h.post(s) }
        let px = UIScreen.main.nativeBounds.size
        core.send(msg("screen.policy", ["accept": true, "width": Int(max(px.width, px.height)), "height": Int(min(px.width, px.height))]))
        if state == nil { wantStart = true } else { startIfNeeded() }
        UIApplication.shared.isIdleTimerDisabled = true
        core.changed()
    }

    func detach(_ h: WebHost) {
        guard host === h else { return }
        host = nil
        viewing = false
        size = nil
        wantStart = false
        if core.connected {
            core.send(msg("screen.policy", ["accept": false]))
            if startedByUs && sharing { control(share: false) }
        }
        startedByUs = false
        autoOpened = false
        UIApplication.shared.isIdleTimerDisabled = false
        core.changed()
    }

    private func startIfNeeded() {
        wantStart = false
        guard viewing, !sharing, remote else { return }
        startedByUs = true
        control(share: true, mode: modes.contains("mirror") ? "mirror" : (modes.first ?? "mirror"))
    }

    func control(share: Bool? = nil, mode: String? = nil, close: Bool = false) {
        var m = msg("screen.ctl")
        if let s = share { m["share"] = s }
        if let md = mode { m["mode"] = md }
        if close { m["close"] = true }
        if share == false { startedByUs = false }
        core.send(m)
    }

    func pick(_ mode: String) { control(share: true, mode: mode) }

    // The viewer's Close: the computer stops sharing too.
    func end() { if core.connected && sharing { control(share: false, close: true) } }

    override func onClosed() {
        state = nil
        lastInfo = nil
        startedByUs = false
        host?.post(msg("stream.stop"))
        core.changed()
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case "screen.state":
            let was = state
            state = m
            host?.post(m)
            let on = m.bool("on")
            // Off → on, not asked for here: Share Screen on the computer. Open the viewer (in front)
            // or say so in a notification.
            if let w = was, !w.bool("on"), on, !viewing, !startedByUs {
                autoOpened = true
                if UIApplication.shared.applicationState == .active { autoOpen = true }
                else { Notifier.shared.screen(core.host?.name ?? tr("Your computer")) }
            }
            if !on { Notifier.shared.cancel("screen") }
            if wantStart { startIfNeeded() }
            core.changed()
        case "stream.input": inputOn = (m["on"] as? Bool) ?? true; core.changed()
        case "stream.info": lastInfo = m; host?.post(m)
        case "rtc.offer", "rtc.ice", "stream.stop": host?.post(m)
        default: return false
        }
        return true
    }

    // ---- the keyboard (KeyProxy): characters as the keys that type them, US layout ----

    func typeText(_ text: String) {
        for ch in text {
            if let (code, shift) = Keys.forChar(ch) {
                if shift { key("ShiftLeft", true) }
                key(code, true); key(code, false)
                if shift { key("ShiftLeft", false) }
            }
        }
    }

    func key(_ code: String, _ down: Bool) { core.send(msg(down ? "in.kd" : "in.ku", ["code": code])) }
}

// The computer's sound here (mac/audio.js m2w): accepted while the switch is on, played by
// audio.html in a hidden page.
final class PcSound: Feature {
    private var host: WebHost?
    private(set) var playing = false
    var on: Bool { core.store.flag("audio.in", false) }

    // Shared with the computer (PairSync "audio"): its Send this computer's sound follows.
    func set(_ v: Bool) { core.sync.set("audio", "in", v) }

    func sendPolicy() {
        core.send(msg("audio.policy", ["accept": on]))
        if !on { stop() }
    }

    override func onWelcome(_ host: Computer, _ m: JSON) { sendPolicy() }
    override func onClosed() { stop() }

    private func stop() {
        host?.destroy()
        host = nil
        if playing { playing = false; core.changed() }
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t.hasPrefix("audio."), m.str("dir") == "m2w" else { return false }
        switch t {
        case "audio.offer":
            guard on else { return true }
            let h = host ?? WebHost("audio.html", core: core)
            if host == nil { host = h; HiddenWeb.attach(h) }
            h.post(m)
            playing = true
            core.changed()
        case "audio.stop": stop()
        default: host?.post(m)
        }
        return true
    }
}

// Characters and hardware keys as KeyboardEvent.code names (what in.kd/in.ku and remote.* carry).
enum Keys {
    private static let plain = Array("`1234567890-=[]\\;',./")
    private static let shifted = Array("~!@#$%^&*()_+{}|:\"<>?")
    private static let codes = ["Backquote", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0",
                                "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash"]

    static func forChar(_ ch: Character) -> (String, Bool)? {
        if ch.isASCII, ch.isLetter { return ("Key\(ch.uppercased())", ch.isUppercase) }
        if ch == " " { return ("Space", false) }
        if ch == "\n" || ch == "\r" { return ("Enter", false) }
        if ch == "\t" { return ("Tab", false) }
        if let i = plain.firstIndex(of: ch) { return (codes[i], false) }
        if let i = shifted.firstIndex(of: ch) { return (codes[i], true) }
        return nil
    }

    // A hardware key (UIKeyboardHIDUsage) as its code.
    static func forHID(_ u: Int) -> String? {
        switch u {
        case 0x04...0x1D: return "Key" + String(UnicodeScalar(UInt8(65 + u - 0x04)))
        case 0x1E...0x26: return "Digit\(u - 0x1D)"
        case 0x27: return "Digit0"
        case 0x28: return "Enter"
        case 0x29: return "Escape"
        case 0x2A: return "Backspace"
        case 0x2B: return "Tab"
        case 0x2C: return "Space"
        case 0x2D: return "Minus"
        case 0x2E: return "Equal"
        case 0x2F: return "BracketLeft"
        case 0x30: return "BracketRight"
        case 0x31: return "Backslash"
        case 0x33: return "Semicolon"
        case 0x34: return "Quote"
        case 0x35: return "Backquote"
        case 0x36: return "Comma"
        case 0x37: return "Period"
        case 0x38: return "Slash"
        case 0x39: return "CapsLock"
        case 0x3A...0x45: return "F\(u - 0x39)"
        case 0x49: return "Insert"
        case 0x4A: return "Home"
        case 0x4B: return "PageUp"
        case 0x4C: return "Delete"
        case 0x4D: return "End"
        case 0x4E: return "PageDown"
        case 0x4F: return "ArrowRight"
        case 0x50: return "ArrowLeft"
        case 0x51: return "ArrowDown"
        case 0x52: return "ArrowUp"
        case 0xE0: return "ControlLeft"
        case 0xE1: return "ShiftLeft"
        case 0xE2: return "AltLeft"
        case 0xE3: return "MetaLeft"
        case 0xE4: return "ControlRight"
        case 0xE5: return "ShiftRight"
        case 0xE6: return "AltRight"
        case 0xE7: return "MetaRight"
        default: return nil
        }
    }
}

// The soft keyboard for the viewer: a view that takes the typing (WebKit shows its keyboard only for
// a tap in the page) and hardware keys while it has them.
final class KeyProxy: UIView, UIKeyInput {
    var onText: (String) -> Void = { _ in }
    var onKey: (String, Bool) -> Void = { _, _ in }
    override var canBecomeFirstResponder: Bool { true }
    var hasText: Bool { true }
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var keyboardType: UIKeyboardType = .asciiCapable

    func insertText(_ text: String) { onText(text) }
    func deleteBackward() { onKey("Backspace", true); onKey("Backspace", false) }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for p in presses { if let k = p.key, let c = Keys.forHID(k.keyCode.rawValue) { onKey(c, true); handled = true } }
        if !handled { super.pressesBegan(presses, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for p in presses { if let k = p.key, let c = Keys.forHID(k.keyCode.rawValue) { onKey(c, false); handled = true } }
        if !handled { super.pressesEnded(presses, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) { pressesEnded(presses, with: event) }
}
