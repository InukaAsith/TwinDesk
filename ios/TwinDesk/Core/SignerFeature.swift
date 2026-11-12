// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// App refresh (opt in): TwinDesk on this iPhone signed again with the person's own Apple ID by the
// computer it is connected to (shared/iossign.js and ios-signer/ there), in place of AltStore.
// This keeps the signing state (Signer.swift: SignerVault) and answers the computer's helper
// through a seal made for each run (SignerSeal), so any paired computer can do a refresh and none
// has to keep a thing.
//   sign.state  → computer   what this holds: {signedIn, email, until, auto}
//   sign.info   ← computer   what it can do and what's sideloaded here, each with its last day
//   sign.start  → computer   a run: it answers sign.key {pub}; this sends sign.box {pub, box}
//   sign.ev     ← computer   the helper's events; its questions are answered with sign.box {box}
//   sign.want   ← computer   an app here runs out soon (or Refresh was clicked there): {now, app,
//                            name, expires, ask}. Now, or in front and unlocked: the refresh runs.
//                            Otherwise a notification says how long is left; tapping it opens
//                            TwinDesk, which connects and runs the refresh by itself.
//   sign.keep   ↔            the state: from a run typed on the computer, for this to keep; to a
//                            computer with Keep a copy on (said in sign.info), its copy
//   sign.want {update: version}  a newer release: signed and installed over this one (Update
//                            TwinDesk, by itself or tapped); sign.start {update: true} runs it.
//   sign.set    → computer   App refresh switched here {on}: the computer's TwinDesk iPhone follows.
//                            The other way, sign.info {on, switched}: on there turns it on here;
//                            switched off there just now turns it off here.
import Foundation
import UIKit

final class Signer: Feature {
    struct App: Identifiable {
        let id: String, name: String, version: String, teamName: String, expires: Double, twindesk: Bool, cached: Bool
    }
    struct Cert: Identifiable {
        let id: String, name: String, expires: Double, ours: Bool
    }
    enum Need { case code(String), certs([Cert]) }

    // What the computer said (sign.info).
    private(set) var available = false
    private(set) var seen = false // the computer sees this device for installing right now (cable or Wi-Fi sync)
    private(set) var anyIpa = false
    private(set) var anisette = ""
    private(set) var computerKeeps = false
    private(set) var apps: [App] = []
    private(set) var latest = "" // the latest release, as the computer looked it up
    private(set) var computerUpdates = false // the computer updates TwinDesk by itself
    // A run: step nil when none.
    private(set) var step: String?
    private(set) var done: [String] = [] // the run's steps so far, in order
    private(set) var percent = 0
    private(set) var need: Need?
    private(set) var error: String?
    private(set) var needsSignIn = false
    private(set) var doneUntil: Date?

    private var seal: SignerSeal?
    private var typed: (email: String, password: String)?
    private var ipa: (name: String, size: Int64, path: String?)?
    private var gaveCopy = false
    private var app: String? // a run for this app, from the IPA the computer keeps
    private var fresh = false // Start over: TwinDesk's certificate revoked at Apple, a new one made
    private var tapped: String? // the notification was tapped: this refresh ("" TwinDesk, "#update" an update) runs once it can
    private var updating = false // this run installs the latest release (Update TwinDesk)

    // Installed by a computer's TwinDesk (its signer marks the Info.plist; AltStore and SideStore
    // don't), or refreshed by one since. Overview's refresh card and Update TwinDesk show only then.
    static let marked: Bool = (Bundle.main.object(forInfoDictionaryKey: "TDInstalledBy") as? String) == "TwinDesk"
    var mine: Bool { Self.marked || core.store.flag("sign.mine", false) }

    // A newer release than this TwinDesk (the computer's lookup, or this app's own check), "" none.
    var newer: String {
        let cur = core.updates.current
        let best = [latest, core.updates.latest].filter { !$0.isEmpty }.max { Updates.compare($0, $1) < 0 } ?? ""
        return !best.isEmpty && Updates.compare(best, cur) > 0 ? best : ""
    }
    // Update TwinDesk can run now: installed by a computer, App refresh on and ready there, signed in.
    var canUpdate: Bool { mine && on && core.connected && available && facts.signedIn && !newer.isEmpty }

    // When TwinDesk here runs out: its own provisioning profile's ExpirationDate (0 unknown).
    static let expires: Double = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url),
              let start = raw.range(of: Data("<?xml".utf8)), let end = raw.range(of: Data("</plist>".utf8), in: start.lowerBound..<raw.endIndex),
              let d = try? PropertyListSerialization.propertyList(from: raw[start.lowerBound..<end.upperBound], format: nil) as? [String: Any],
              let date = d["ExpirationDate"] as? Date else { return 0 }
        return date.timeIntervalSince1970
    }()

    // The card on Overview in TwinDesk's last 7 days (on unless switched off in App refresh).
    var homeCard: Bool {
        get { core.store.flag("sign.home", true) }
        set { core.store.setFlag("sign.home", newValue); core.changed() }
    }

    // Refresh by itself when the computer says it's time (on).
    var auto: Bool {
        get { core.store.flag("sign.auto", true) }
        set { core.store.setFlag("sign.auto", newValue); tell(); core.changed() }
    }

    // Off until turned on, here (behind its warning) or on the computer (behind the same warning
    // there): the two follow each other. Off: nothing is asked of the computer.
    var on: Bool {
        get { core.store.flag("sign.on", false) }
        set { switchOn(newValue, here: true) }
    }

    // Switched here: the computer is told (now, or when it next connects). Switched there: followed,
    // and the session here stays (turning it off here is what signs out).
    private var told = Date.distantPast
    private func switchOn(_ v: Bool, here: Bool) {
        guard v != on else { return }
        core.store.setFlag("sign.on", v)
        if here {
            if !v { SignerVault.signOut(everything: false) }
            core.store.setFlag("sign.sync", true) // to tell the computer
            sendSwitch()
        }
        tell()
        core.changed()
    }

    private func sendSwitch() {
        guard core.store.flag("sign.sync", false), core.send(msg("sign.set", ["on": on])) else { return }
        core.store.setFlag("sign.sync", false)
        told = Date()
    }

    var running: Bool { step != nil }
    var facts: (email: String, until: Double, signedIn: Bool) { SignerVault.facts }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        available = false; apps = []; gaveCopy = false
        sendSwitch() // switched here while it wasn't connected
        tell()
    }

    override func onClosed() {
        available = false
        if running { finish(error: tr("The computer disconnected")) }
        core.changed()
    }

    private func tell() {
        let f = facts
        core.send(msg("sign.state", ["signedIn": on && f.signedIn, "email": on ? f.email : "", "until": f.until, "auto": on && auto, "expires": Self.expires]))
    }

    private func finish(error e: String? = nil, until: Date? = nil) {
        step = nil; need = nil; seal = nil; typed = nil; ipa = nil; app = nil; fresh = false; updating = false; percent = 0; done = []
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

    // One app again, from the IPA the computer keeps for it.
    func refresh(app id: String) {
        guard !running, core.connected, available, facts.signedIn else { return }
        app = id
        begin()
    }

    // Update TwinDesk: the computer downloads the latest release, signs it with the session kept here
    // and installs it over this one (the app closes as it's replaced; its data stays).
    func update() {
        guard !running, core.connected, available else { return }
        guard facts.signedIn else { needsSignIn = true; core.changed(); return }
        updating = true
        begin()
    }

    // Start over: TwinDesk's certificate is revoked at Apple and a new one made, then TwinDesk signed
    // and installed with it (the page asks first).
    func startOver() {
        guard !running, core.connected, available, facts.signedIn else { return }
        fresh = true
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
        error = nil; doneUntil = nil; needsSignIn = false; need = nil; percent = 0; done = []
        step = "start"
        var m: JSON = [:]
        if let i = ipa, let p = i.path { m["ipa"] = ["path": p, "size": i.size] }
        if let a = app { m["app"] = a }
        if fresh { m["fresh"] = true }
        if updating { m["update"] = true }
        core.send(msg("sign.start", m))
        core.changed()
    }

    func answer(code: String) { answer(["code": code]) }
    // One the person picked (another tool's after the page's warning: the apps it signed stop).
    func revoke(_ serial: String) {
        guard case .certs(let certs)? = need, certs.contains(where: { $0.id == serial }) else { return }
        answer(["revoke": [serial]])
    }
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

    // The notification was tapped: TwinDesk is in front now. The refresh runs as soon as the computer
    // is connected and has said it can sign (sign.info), with nothing else to tap.
    func tappedNotification(app id: String?) {
        guard on else { return }
        tapped = id ?? ""
        AppUI.shared.open(.signing)
        core.wake()
        runTapped()
    }

    private func runTapped() {
        guard let id = tapped, on, !running, core.connected, available else { return }
        tapped = nil
        guard facts.signedIn else { needsSignIn = true; core.changed(); return }
        if id == "#update" { update() } else if id.isEmpty { refresh() } else { refresh(app: id) }
    }

    // Asked by the computer while not in front (or locked): a notification to tap.
    private func notify(_ m: JSON) {
        let name = m.str("name", max: 100)
        let exp = (m["expires"] as? NSNumber)?.doubleValue ?? Self.expires
        let secs = exp - Date().timeIntervalSince1970
        let left = exp <= 0 ? "" : secs <= 0 ? tr("It has expired.") : secs >= 86400 ? tr("{count} days left.", ["count": "\(Int(secs / 86400))"]) : tr("{count} hours left.", ["count": "\(max(1, Int(secs / 3600)))"])
        Notifier.shared.signRefresh(app: m.str("app", max: 200), name: name.isEmpty ? "TwinDesk" : name, left: left, computer: core.host?.name ?? tr("the computer"))
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
            // On there: on here too. Off there: only when switched off there just now (another
            // computer that never turned it on doesn't turn it off here). Just told it ourselves: ours stands.
            if m["on"] != nil, Date().timeIntervalSince(told) > 5 {
                if m.bool("on") { switchOn(true, here: false) } else if m.bool("switched") { switchOn(false, here: false) }
            }
            available = m.bool("available")
            seen = m.bool("seen")
            anyIpa = m.bool("anyIpa")
            anisette = m.str("anisette", max: 200)
            computerKeeps = m.bool("keep")
            latest = m.str("latest", max: 40)
            computerUpdates = m.bool("autoUpdate")
            apps = ((m["apps"] as? [JSON]) ?? []).prefix(50).map {
                App(id: $0.str("bundleId"), name: $0.str("name", max: 100), version: $0.str("version", max: 40), teamName: $0.str("teamName", max: 100),
                    expires: ($0["expires"] as? NSNumber)?.doubleValue ?? 0, twindesk: $0.bool("twindesk"), cached: $0.bool("cached"))
            }
            // A computer that keeps a copy (switched on there, behind its warning) gets it once a session.
            if on, computerKeeps, !gaveCopy, facts.signedIn { gaveCopy = true; core.send(msg("sign.keep", ["state": SignerVault.state])) }
            core.changed()
            runTapped()
        case "sign.want":
            guard on, !running, facts.signedIn, m.bool("now") || auto else { return true }
            let id = m.str("app", max: 200)
            let state = UIApplication.shared.applicationState
            let unlocked = UIApplication.shared.isProtectedDataAvailable
            let version = m.str("update", max: 40)
            if !version.isEmpty {
                // An update closes the app as it installs: now when asked from the computer, or by
                // itself while TwinDesk is in the background and unlocked; in front, a notification.
                if m.bool("now") && unlocked || (state != .active && unlocked && !m.bool("ask")) { update() }
                else { Notifier.shared.signUpdate(version: version, computer: core.host?.name ?? tr("the computer")) }
                return true
            }
            // Clicked on the computer, or TwinDesk in front: now. By itself (not Ask first) and
            // unlocked: now too, in the background. Otherwise the notification, to tap.
            if m.bool("now") && unlocked || state == .active || (!m.bool("ask") && unlocked) {
                if id.isEmpty { refresh() } else { refresh(app: id) }
            } else {
                notify(m)
            }
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
            if on || !f.signedIn, !f.signedIn || f.email == (s["email"] ?? "") { SignerVault.save(state: s); tell(); core.changed() }
        case "sign.ev":
            event(m)
        default:
            return false
        }
        return true
    }

    private func event(_ m: JSON) {
        switch m.str("ev", max: 20) {
        case "step":
            let st = m.str("step", max: 20)
            step = st; need = nil; percent = 0
            if !done.contains(st) { done.append(st) }
        case "progress":
            let st = m.str("step", max: 20).isEmpty ? "install" : m.str("step", max: 20)
            if st != step { need = nil }
            step = st
            if !done.contains(st) { done.append(st) }
            percent = m.int("percent")
        case "need2fa": need = .code(m.str("error", max: 200))
        case "needcert":
            need = .certs(((m["certs"] as? [JSON]) ?? []).prefix(20).map {
                Cert(id: $0.str("serial", max: 80), name: [$0.str("machine", max: 100), $0.str("name", max: 100)].first { !$0.isEmpty } ?? "", expires: ($0["expires"] as? NSNumber)?.doubleValue ?? 0,
                     ours: $0.bool("ours") || $0.str("machine", max: 100) == "TwinDesk")
            }.sorted { $0.ours && !$1.ours }) // TwinDesk's own first
        case "state":
            if let s = seal?.open(state: m.str("box", max: 400_000)) {
                SignerVault.save(state: s)
                tell()
                if computerKeeps { core.send(msg("sign.keep", ["state": s])) }
            }
        case "done":
            if m.str("bundleId", max: 200) == Bundle.main.bundleIdentifier { core.store.setFlag("sign.mine", true) } // refreshed by a computer: ours from now on
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
