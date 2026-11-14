// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two-way switches shared with the computer, remembered per pair (mac/pairsync.js, PairSync.kt):
// the computer hosts, so after welcome it sends all of them and we adopt them; after that either
// side sends one when its person flips it. Directions are told from the sender's side.
import Foundation

final class PairSync: Feature {
    // feature -> our keys for out (ours shown there) / in (theirs shown here)
    // (General › Shared with the computer lists them, as the computers' pages and the Android app
    // have them.) An empty key: no such direction here.
    private let keys: [String: (String, String)] = [
        "clipboard": ("clip.send", "clip.receive"),
        "notifs": ("notifs.send", "notifs.receive"),
        "audio": ("", "audio.in"), // in: the computer's sound here (its Send this computer's sound follows)
        "remote": ("remote.allow", ""), // out: this device's Remote may move the computer (its Remote › Allow)
        "files": ("files.send", ""), // out: the computer takes files dropped from here (its Accept files)
        "mic": ("mic.send", ""), // out: this device's microphone on the computer (its Use the iPhone's microphone)
    ]

    // Shared values, the same on both sides (the computers' VALUES): stored as strings.
    static let valueDefaults: [String: String] = ["pace": "fast", "res": "1080"] // res: the screen's Resolution (the computer's Share screen › Resolution)

    func value(_ key: String) -> String { core.store.string("value." + key, Self.valueDefaults[key] ?? "") }

    // The person changed a value here: the computer follows.
    func setValue(_ key: String, _ v: Any) {
        core.store.setString("value." + key, "\(v)")
        core.send(msg(Proto.T.pairSync, ["key": key, "value": v]))
        core.changed()
    }

    private func adoptValue(_ key: String, _ v: Any?) {
        guard Self.valueDefaults[key] != nil, let v = v, !(v is NSNull) else { return }
        core.store.setString("value." + key, "\(v)")
    }

    func has(_ feature: String, _ dir: String) -> Bool {
        guard let (o, i) = keys[feature] else { return false }
        return !(dir == "out" ? o : i).isEmpty
    }

    func get(_ feature: String, _ dir: String) -> Bool {
        guard let (o, i) = keys[feature] else { return false }
        // The iPhone can't read other apps' notifications: never "out" for notifs.
        if feature == "notifs" && dir == "out" { return false }
        let k = dir == "out" ? o : i
        if k.isEmpty { return false }
        return core.store.flag(k, false) // on only when saved on
    }

    // The person flipped a switch here: tell the computer, which follows.
    func set(_ feature: String, _ dir: String, _ on: Bool) {
        apply(feature, dir, on)
        core.send(msg(Proto.T.pairSync, ["feature": feature, "dir": dir, "on": on]))
        remember()
    }

    private func apply(_ feature: String, _ dir: String, _ on: Bool) {
        guard let (o, i) = keys[feature], has(feature, dir), get(feature, dir) != on else { return }
        core.store.setFlag(dir == "out" ? o : i, on)
        switch feature {
        case "clipboard": core.clip.sendPolicy()
        case "notifs": core.notifs.sendPolicy()
        case "audio": core.sound.sendPolicy()
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
        if m.has("key") {
            adoptValue(m.str("key", max: 40), m["value"])
            core.changed()
            return true
        }
        if let all = m.obj("all") {
            if let vals = all["values"] as? JSON { for (k, v) in vals { adoptValue(k, v) } }
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
        for f in keys.keys {
            var d: JSON = [:]
            if has(f, "out") { d["out"] = get(f, "out") }
            if has(f, "in") { d["in"] = get(f, "in") }
            o[f] = d
        }
        core.store.setPairSync(h.id, o)
    }
}
