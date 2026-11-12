// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck (shared/deck.js on the computer, android/…/Deck.kt): tiles here that the computer runs —
// shortcuts, text, media, sound, Bluetooth, brightness, windows, apps, websites, the clipboard — in
// spaces of pages, and a window space (pick a running app, tap a zone of a layout, or send the window
// to another display). The computer keeps the layout (shared/deck-model.js); this device edits a
// tile's action, look and size and adds or removes tiles and pages (deck.save). Dragging tiles and
// drawing window layouts happen on the computer's Deck page. Paths of files and scripts never come here.
// Shown only while the computer offers it (deck.offer: its Deck module is on).
import Foundation
import UIKit

final class Deck: Feature {
    private(set) var offered = false
    private(set) var layout: JSON?
    private(set) var can = Set<String>()
    private(set) var caps: JSON?
    private(set) var platform = ""
    private(set) var apps: [(id: String, name: String)]?
    private(set) var state: JSON? // levels, devices and switches there (deck.state)
    private(set) var wins: JSON?  // the window space's apps, windows and displays (deck.wins)
    private(set) var done: (id: String, why: String)? // the last tile's answer ("" when it ran)

    var spaces: [JSON] { (layout?["spaces"] as? [JSON]) ?? [] }
    var swipePages: Bool { (layout?.obj("swipe")?["pages"] as? NSNumber)?.boolValue ?? true }
    var swipeSpaces: Bool { (layout?.obj("swipe")?["spaces"] as? NSNumber)?.boolValue ?? true }
    // How the full-screen Deck is held (layout.orient, set on the computer's Deck page or here): landscape unless portrait.
    var portrait: Bool { layout?.str("orient") == "portrait" }

    private func reset() { offered = false; layout = nil; apps = nil; state = nil; wins = nil; done = nil }
    override func onWelcome(_ host: Computer, _ m: JSON) { DispatchQueue.main.async { self.reset(); self.core.changed() } }
    override func onClosed() { DispatchQueue.main.async { self.reset(); self.core.changed() } }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case "deck.offer":
            DispatchQueue.main.async { self.offered = true; _ = self.core.send(msg("deck.hello")); self.core.changed() }
        case "deck.layout":
            DispatchQueue.main.async {
                self.layout = m.obj("layout")
                self.can = Set((m["can"] as? [String]) ?? [])
                self.caps = m.obj("caps")
                let p = m.str("platform", max: 10)
                self.platform = p.isEmpty ? (m.bool("mac") ? "mac" : "") : p
                self.core.changed()
            }
        case "deck.done":
            DispatchQueue.main.async { self.done = (m.str("id", max: 40), m.bool("ok") ? "" : m.str("why", max: 300)); self.core.changed() }
        case "deck.state":
            DispatchQueue.main.async { if let s = m.obj("state") { self.state = s; self.core.changed() } }
        case "deck.wins":
            DispatchQueue.main.async { self.wins = m; self.core.changed() }
        case "deck.apps":
            DispatchQueue.main.async {
                self.apps = ((m["apps"] as? [JSON]) ?? []).map { ($0.str("id"), $0.str("name", max: 80)) }
                self.core.changed()
            }
        case "deck.clip":
            let text = m.str("text", max: 100_000)
            DispatchQueue.main.async { UIPasteboard.general.string = text }
        default:
            return false
        }
        return true
    }

    func run(_ id: String) { done = nil; _ = core.send(msg("deck.run", ["id": id])) }
    func set(_ id: String, _ value: Double) { _ = core.send(msg("deck.set", ["id": id, "value": value])) }
    func askState() { _ = core.send(msg("deck.state")) }
    func askWins() { _ = core.send(msg("deck.wins")) }
    func askApps() { if apps == nil { _ = core.send(msg("deck.apps")) } }
    // Apps side by side: [{key, wid?, zone}] on a display (one not running is opened on the computer).
    func arrange(display: String, items: [JSON]) { done = nil; _ = core.send(msg("deck.arrange", ["display": display, "items": items])) }
    // A window's own buttons: close, min, max, full.
    func winOp(_ wid: Int64, _ op: String) { done = nil; _ = core.send(msg("deck.place", ["wid": wid, "op": op])) }
    // A minimized window brought back as it was.
    func restore(_ wid: Int64) { done = nil; _ = core.send(msg("deck.place", ["wid": wid, "restore": true])) }
    func place(_ wid: Int64, display: String, zone: JSON?) {
        done = nil
        var m: JSON = ["wid": wid, "display": display]
        if let z = zone { m["zone"] = z }
        _ = core.send(msg("deck.place", m))
    }

    // Edited here: shown at once; the computer keeps its own paths, normalizes it and sends it back.
    func save(_ l: JSON) { layout = l; core.changed(); _ = core.send(msg("deck.save", ["layout": l])) }
    func edit(_ fn: (inout JSON) -> Void) {
        guard var l = layout else { return }
        fn(&l)
        save(l)
    }

    // A tile by its id, wherever it is: the tile and its page.
    func find(_ id: String) -> (tile: JSON, page: JSON)? {
        for s in spaces { for p in (s["pages"] as? [JSON]) ?? [] { for t in (p["tiles"] as? [JSON]) ?? [] where t.str("id") == id { return (t, p) } } }
        return nil
    }

    // Whether the computer can run this action (its kind, and the entry's needs).
    func runs(_ a: JSON) -> Bool {
        let k = a.str("k")
        if k == "nav" || k == "none" { return true }
        if k == "widget" { return DeckCatalog.entry(a).map { DeckCatalog.available($0, caps, platform) == nil } ?? true }
        if !can.contains(k) { return false }
        guard let e = DeckCatalog.entry(a) else { return true }
        return DeckCatalog.available(e, caps, platform) == nil
    }
}

// Changing the layout as JSON: a space, a page, a tile by id, wherever it is.
extension Deck {
    static func mapSpaces(_ l: inout JSON, _ fn: (inout JSON) -> Void) {
        var ss = (l["spaces"] as? [JSON]) ?? []
        for i in ss.indices { fn(&ss[i]) }
        l["spaces"] = ss
    }
    static func mapPages(_ l: inout JSON, _ fn: (inout JSON) -> Void) {
        mapSpaces(&l) { s in
            var ps = (s["pages"] as? [JSON]) ?? []
            for i in ps.indices { fn(&ps[i]) }
            if s["pages"] != nil { s["pages"] = ps }
        }
    }
    static func editPage(_ l: inout JSON, _ id: String, _ fn: (inout JSON) -> Void) {
        mapPages(&l) { p in if p.str("id") == id { fn(&p) } }
    }
    static func editTile(_ l: inout JSON, _ id: String, _ fn: (inout JSON) -> Void) {
        mapPages(&l) { p in
            var ts = (p["tiles"] as? [JSON]) ?? []
            var hit = false
            for i in ts.indices where ts[i].str("id") == id { fn(&ts[i]); hit = true }
            if hit { p["tiles"] = ts }
        }
    }
    static func newId(_ p: String) -> String { p + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<1296), radix: 36) }
}
