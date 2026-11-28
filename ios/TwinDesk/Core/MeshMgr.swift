// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The mesh manager (shared/mesh-manage.js; android/…/MeshMgr.kt): every computer of the connected
// computer's mesh on Overview, not only the connected one. Wake one that's off, lock, unlock (Full KVM),
// sleep, restart or shut down any of them, answer a pairing waiting on one, remove a device from the
// mesh, and move devices on the layout. The connected computer relays to the others. Strong actions
// (restart, shut down, unlock, pairings, removing) ask for Face ID, Touch ID or the passcode first;
// each computer may turn this off or revoke the phone.
//   mesh.ask → while Overview is on screen (every 30 s); mesh.view ← the whole mesh
//   mesh.do {rid, to, do, dev?, x?, y?} → ; mesh.done {rid, ok, why} ←
// One-to-one computers (no mesh) never answer: no card.
import Foundation
import LocalAuthentication

final class MeshMgr: Feature {
    struct Dev: Identifiable {
        let id, name, os: String
        let me, online, on, said: Bool
        let can: Set<String>
        let pending: (name: String, os: String, code: String)?
    }

    private(set) var view: JSON?
    private(set) var result = ""
    private var waiting: [String: String] = [:] // rid → what was asked, for the line under the card
    private var looking = 0
    private var seq = 0
    private var timer: Timer?

    // Overview came on screen / went: ask only while someone looks (main thread).
    func look(_ on: Bool) {
        looking = max(0, looking + (on ? 1 : -1))
        timer?.invalidate(); timer = nil
        guard looking > 0 else { return }
        ask()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.ask() }
    }

    private func ask() { if core.connected { _ = core.send(msg("mesh.ask")) } }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        DispatchQueue.main.async { self.view = nil; self.result = ""; if self.looking > 0 { self.ask() } }
    }
    override func onClosed() { DispatchQueue.main.async { self.view = nil; self.waiting = [:]; self.core.changed() } }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case "mesh.view":
            DispatchQueue.main.async { self.view = m; self.core.changed() }
        case "mesh.done":
            DispatchQueue.main.async {
                guard let what = self.waiting.removeValue(forKey: m.str("rid", max: 40)) else { return }
                self.result = m.bool("ok") ? tr("{what}: done", ["what": what]) : tr("{what}: {why}", ["what": what, "why": Self.why(m.str("why", max: 20))])
                self.core.changed()
            }
        default:
            return false
        }
        return true
    }

    static func why(_ w: String) -> String {
        switch w {
        case "off": return tr("that computer doesn’t let phones manage it")
        case "revoked": return tr("that computer revoked this phone")
        case "cant": return tr("that computer can’t do it")
        case "nothing": return tr("nothing to do")
        case "offline": return tr("not connected")
        case "timeout": return tr("no answer (an older TwinDesk there?)")
        default: return tr("didn’t work")
        }
    }

    var devices: [Dev] {
        ((view?["devices"] as? [JSON]) ?? []).map { d in
            let c = d.obj("can") ?? [:]
            let p = d.obj("pending")
            return Dev(id: d.str("id", max: 64), name: d.str("name", max: 64), os: d.str("os", max: 10), me: d.bool("self"),
                       online: d.bool("online"), on: (d["on"] as? NSNumber)?.boolValue ?? true, said: d.bool("said"),
                       can: Set(c.keys.filter { (c[$0] as? NSNumber)?.boolValue ?? false }),
                       pending: p.map { ($0.str("name", max: 64), $0.str("os", max: 10), $0.str("code", max: 12)) })
        }
    }

    var strong: Set<String> {
        guard let a = view?["strong"] as? [String] else { return ["unlock", "restart", "shutdown", "approve", "remove"] }
        return Set(a)
    }

    func act(to: String, _ what: String, label: String, dev: String = "", x: Int? = nil, y: Int? = nil) {
        seq += 1
        let rid = "m\(seq)-\(Int(Date().timeIntervalSince1970 * 1000) % 100000)"
        waiting[rid] = label
        result = tr("{what}…", ["what": label])
        var m = msg("mesh.do", ["rid": rid, "to": to, "do": what])
        if !dev.isEmpty { m["dev"] = dev }
        if let x { m["x"] = x }
        if let y { m["y"] = y }
        _ = core.send(m)
        core.changed()
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            if self.waiting.removeValue(forKey: rid) != nil { self.result = tr("{what}: {why}", ["what": label, "why": Self.why("timeout")]); self.core.changed() }
        }
    }

    // Face ID, Touch ID or the passcode before a strong action; an iPhone without a passcode can't do them.
    static func confirm(_ title: String, ok: @escaping () -> Void, refused: @escaping (String) -> Void) {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return refused(tr("Set a passcode on this iPhone first")) }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: title) { good, e in
            DispatchQueue.main.async {
                if good { ok() }
                else if let e = e as? LAError, e.code != .userCancel, e.code != .appCancel, e.code != .systemCancel { refused(e.localizedDescription) }
            }
        }
    }
}
