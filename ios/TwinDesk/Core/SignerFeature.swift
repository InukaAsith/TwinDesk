// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// App signing (opt in): TwinDesk on this iPhone signed again with the person's own Apple ID by the
// computer it is connected to (shared/iossign.js and ios-signer/ there), in place of AltStore.
// This keeps the signing state (Signer.swift: SignerVault) and answers the computer's helper
// through a seal made for each run (SignerSeal), so any paired computer can do a refresh and none
// has to keep a thing.
//   sign.state  → computer   what this holds: {signedIn, email, until, auto}
//   sign.info   ← computer   what it can do and what's sideloaded here, each with its last day
//   sign.start  → computer   a run: it answers sign.key {pub}; this sends sign.box {pub, box}
//   sign.ev     ← computer   the helper's events; its questions are answered with sign.box {box}
//   sign.want   ← computer   TwinDesk here runs out soon (or Refresh was clicked there)
//   sign.keep   ↔            the state: from a run typed on the computer, for this to keep; to a
//                            computer with Keep a copy on (said in sign.info), its copy
import Foundation

final class Signer: Feature {
    struct App: Identifiable {
        let id: String, name: String, version: String, teamName: String, expires: Double, twindesk: Bool
    }
    struct Cert: Identifiable {
        let id: String, name: String, expires: Double
    }
    enum Need { case code(String), certs([Cert]) }

    // What the computer said (sign.info).
    private(set) var available = false
    private(set) var anyIpa = false
    private(set) var anisette = ""
    private(set) var computerKeeps = false
    private(set) var apps: [App] = []
    // A run: step nil when none.
    private(set) var step: String?
    private(set) var percent = 0
    private(set) var need: Need?
    private(set) var error: String?
    private(set) var needsSignIn = false
    private(set) var doneUntil: Date?

    private var seal: SignerSeal?
    private var typed: (email: String, password: String)?
    private var ipa: (name: String, size: Int64, path: String?)?
    private var gaveCopy = false

    // Refresh by itself when the computer says it's time (on).
    var auto: Bool {
        get { core.store.flag("sign.auto", true) }
        set { core.store.setFlag("sign.auto", newValue); tell(); core.changed() }
    }

    var running: Bool { step != nil }
    var facts: (email: String, until: Double, signedIn: Bool) { SignerVault.facts }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        available = false; apps = []; gaveCopy = false
        tell()
    }

    override func onClosed() {
        available = false
        if running { finish(error: tr("The computer disconnected")) }
        core.changed()
    }

    private func tell() {
        let f = facts
        core.send(msg("sign.state", ["signedIn": f.signedIn, "email": f.email, "until": f.until, "auto": auto]))
    }

    private func finish(error e: String? = nil, until: Date? = nil) {
        step = nil; need = nil; seal = nil; typed = nil; ipa = nil; percent = 0
        error = e
        doneUntil = until
        core.changed()
    }

    // ---- what the page does ----

    // Refresh TwinDesk with the session kept here.
    func refresh() {
        guard !running, core.connected, available else { return }
        guard facts.signedIn else { needsSignIn = true; core.changed(); return }
        begin()
    }

    // Sign in (the password is used for this one run) and refresh.
    func signIn(email: String, password: String) {
        guard !running, core.connected, available, !email.isEmpty, !password.isEmpty else { return }
        typed = (email, password)
        begin()
    }

    // Install an IPA picked here: it goes to the computer as any file does, then is signed there.
    func install(_ url: URL) {
        guard !running, core.connected, available, anyIpa, facts.signedIn else { return }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).flatMap { $0 }.map(Int64.init) ?? 0
        guard core.files.send([url]) else { return }
        ipa = (url.lastPathComponent, size, nil)
        error = nil; doneUntil = nil
        step = "upload"
        core.changed()
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { [weak self] in
            if let s = self, s.step == "upload" { s.finish(error: tr("The file didn’t reach the computer")) }
        }
    }

    private func begin() {
        error = nil; doneUntil = nil; needsSignIn = false; need = nil; percent = 0
        step = "start"
        var m: JSON = [:]
        if let i = ipa, let p = i.path { m["ipa"] = ["path": p, "size": i.size] }
        core.send(msg("sign.start", m))
        core.changed()
    }

    func answer(code: String) { answer(["code": code]) }
    func revoke(_ serial: String) { answer(["revoke": [serial]]) }
    func cancelQuestion() { answer(["abort": true]) }

    private func answer(_ a: [String: Any]) {
        guard let box = seal?.answer(a) else { return }
        need = nil
        core.send(msg("sign.box", box))
        core.changed()
    }

    func stop() {
        guard running else { return }
        core.send(msg("sign.stop"))
        finish()
    }

    func signOut(everything: Bool) {
        SignerVault.signOut(everything: everything)
        needsSignIn = false
        tell()
        core.changed()
    }

    // ---- the computer ----

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case Proto.T.fileDone:
            // The IPA sent for signing is on the computer: start the run with where it is.
            if step == "upload", var i = ipa, i.path == nil, m.bool("ok") {
                let path = m.str("path", max: 1000)
                let last = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
                if last == i.name { i.path = path; ipa = i; begin() }
            }
            return false // Files' too
        case "sign.info":
            available = m.bool("available")
            anyIpa = m.bool("anyIpa")
            anisette = m.str("anisette", max: 200)
            computerKeeps = m.bool("keep")
            apps = ((m["apps"] as? [JSON]) ?? []).prefix(50).map {
                App(id: $0.str("bundleId"), name: $0.str("name", max: 100), version: $0.str("version", max: 40), teamName: $0.str("teamName", max: 100),
                    expires: ($0["expires"] as? NSNumber)?.doubleValue ?? 0, twindesk: $0.bool("twindesk"))
            }
            // A computer that keeps a copy (switched on there, behind its warning) gets it once a session.
            if computerKeeps, !gaveCopy, facts.signedIn { gaveCopy = true; core.send(msg("sign.keep", ["state": SignerVault.state])) }
            core.changed()
        case "sign.want":
            if !running, facts.signedIn, m.bool("now") || auto { refresh() }
        case "sign.key":
            guard step != nil, let s = SignerSeal(helperKey: m.str("pub", max: 64)),
                  let first = SignerVault.request(for: s, email: typed?.email, password: typed?.password) else {
                finish(error: tr("Unlock the iPhone and try again"))
                core.send(msg("sign.stop"))
                return true
            }
            typed = nil
            seal = s
            core.send(msg("sign.box", first))
        case "sign.keep":
            // A state made on the computer (signed in there): kept when there's no session here, or it's the same Apple ID's.
            guard let s = m["state"] as? [String: String], !s.isEmpty, s.count < 40 else { return true }
            let f = facts
            if !f.signedIn || f.email == (s["email"] ?? "") { SignerVault.save(state: s); tell(); core.changed() }
        case "sign.ev":
            event(m)
        default:
            return false
        }
        return true
    }

    private func event(_ m: JSON) {
        switch m.str("ev", max: 20) {
        case "step": step = m.str("step", max: 20); need = nil
        case "progress": step = "install"; percent = m.int("percent")
        case "need2fa": need = .code(m.str("error", max: 200))
        case "needcert":
            need = .certs(((m["certs"] as? [JSON]) ?? []).prefix(20).map {
                Cert(id: $0.str("serial", max: 80), name: [$0.str("machine", max: 100), $0.str("name", max: 100)].first { !$0.isEmpty } ?? "", expires: ($0["expires"] as? NSNumber)?.doubleValue ?? 0)
            })
        case "state":
            if let s = seal?.open(state: m.str("box", max: 400_000)) {
                SignerVault.save(state: s)
                tell()
                if computerKeeps { core.send(msg("sign.keep", ["state": s])) }
            }
        case "done":
            finish(until: Date(timeIntervalSince1970: (m["expires"] as? NSNumber)?.doubleValue ?? 0))
            return
        case "error":
            let kind = m.str("kind", max: 20)
            if kind == "gone" || !running { return }
            // The computer's words (English, as its own page shows them), and Apple's code when there is one.
            var text = m.str("message", max: 300)
            let detail = m.str("detail", max: 300)
            if !detail.isEmpty, detail != text { text += " " + detail }
            if let code = m["code"] as? NSNumber { text += " (\(code))" }
            if kind == "session" || kind == "password" { needsSignIn = true }
            finish(error: text)
            return
        default: break
        }
        core.changed()
    }
}
