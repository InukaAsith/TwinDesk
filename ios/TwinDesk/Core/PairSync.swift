// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two-way switches shared with the computer, remembered per pair (mac/pairsync.js, PairSync.kt):
// the computer hosts, so after welcome it sends all of them and we adopt them; after that either
// side sends one when its person flips it. Directions are told from the sender's side.
import Foundation

final class PairSync: Feature {
    // feature -> our keys for out (ours shown there) / in (theirs shown here)
    private let keys: [String: (String, String)] = [
        "clipboard": ("clip.send", "clip.receive"),
        "notifs": ("notifs.send", "notifs.receive"),
    ]

    func get(_ feature: String, _ dir: String) -> Bool {
        guard let (o, i) = keys[feature] else { return false }
        // The iPhone can't read other apps' notifications: never "out" for notifs.
        if feature == "notifs" && dir == "out" { return false }
        return core.store.flag(dir == "out" ? o : i, true)
    }

    // The person flipped a switch here: tell the computer, which follows.
    func set(_ feature: String, _ dir: String, _ on: Bool) {
        apply(feature, dir, on)
        core.send(msg(Proto.T.pairSync, ["feature": feature, "dir": dir, "on": on]))
        remember()
    }

    private func apply(_ feature: String, _ dir: String, _ on: Bool) {
        guard let (o, i) = keys[feature], get(feature, dir) != on else { return }
        core.store.setFlag(dir == "out" ? o : i, on)
        switch feature {
        case "clipboard": core.clip.sendPolicy()
        case "notifs": core.notifs.sendPolicy()
        default: break
        }
        core.changed()
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        if let saved = core.store.pairSync(host.id) {
            for f in keys.keys {
                if let v = saved[f] as? JSON {
                    if let o = v["out"] as? Bool { apply(f, "out", o) }
                    if let i = v["in"] as? Bool { apply(f, "in", i) }
                }
            }
        }
        // Ours that the computer can't change: we never send our notifications.
        core.send(msg(Proto.T.pairSync, ["feature": "notifs", "dir": "out", "on": false]))
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == Proto.T.pairSync else { return false }
        if m.has("key") { return true } // shared values (speed, pace…): nothing on the iPhone uses them yet
        if let all = m.obj("all") {
            for f in keys.keys {
                if let v = all[f] as? JSON {
                    apply(f, "out", (v["in"] as? Bool) ?? false) // their in = our out
                    apply(f, "in", (v["out"] as? Bool) ?? false)
                }
            }
        } else if keys[m.str("feature")] != nil {
            let dir = m.str("dir")
            if dir == "out" || dir == "in" { apply(m.str("feature"), dir == "out" ? "in" : "out", m.bool("on")) }
        }
        remember()
        return true
    }

    private func remember() {
        guard let h = core.link.host else { return }
        var o: JSON = [:]
        for f in keys.keys { o[f] = ["out": get(f, "out"), "in": get(f, "in")] }
        core.store.setPairSync(h.id, o)
    }
}
