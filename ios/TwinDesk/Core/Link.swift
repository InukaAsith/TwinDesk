// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The iPhone's side of the session, as android/…/Link.kt: a WSS client with the computer's
// certificate pinned (its SHA-256 is the identity), pairing as the initiator (numeric comparison,
// or Allow only with a QR code's nonce), hello, liveness. The session moves between the network and
// a Bluetooth pipe without ending (move: hello {resume} on a second socket, which takes over once the
// computer says welcome {resumed}), so what's under way on it (a file the computer holds back until
// the session is on Wi-Fi) carries on.
import Foundation

struct PairState: Equatable {
    var phase: String // connecting | starting | code | waiting | failed
    var address: String
    var port: UInt16
    var name: String
    var code = ""
    var error = ""
    var qr = false
}

protocol LinkEvents: AnyObject {
    func linkChanged()
    func linkWelcome(_ host: Computer, _ m: JSON)
    func linkMessage(_ t: String, _ m: JSON)
    func linkClosed(_ host: Computer, _ code: String?)
}

final class Link: NSObject, URLSessionWebSocketDelegate {
    weak var events: LinkEvents?
    private let store = Store.shared
    let q = DispatchQueue(label: "td.link")

    // idle | connecting | connected | failed (read on main through Core's published copy)
    private(set) var state = "idle"
    private(set) var message = ""
    private(set) var pair: PairState?
    private(set) var host: Computer?
    private(set) var rttMs: Int?
    private(set) var address = "" // where the socket goes now
    var connected: Bool { state == "connected" }
    // Through the USB cable (Usb.swift mirrors the computer's port on 127.0.0.1).
    var wired: Bool { address == "127.0.0.1" && !viaBle }

    private var session: URLSession!
    private var ws: URLSessionWebSocketTask?
    private var mode = "" // session | pair
    private var nw = ""
    private var pairNonce = ""
    private var pinFp: String?
    private(set) var seenFp = ""
    private var lastRx = Date()
    private var lastCode: String?
    private var pinger: DispatchSourceTimer?
    private var helloTimer: DispatchWorkItem?
    private(set) var fxToken = ""
    private(set) var viaBle = false // through a Bluetooth pipe (Ble.swift) on 127.0.0.1
    var bleRx: () -> Date = { .distantPast } // bytes through Bluetooth count as alive (a big message takes seconds)
    private var timeout: TimeInterval { viaBle ? 20 : Proto.timeout }
    private(set) var fx2Port: UInt16 = 0 // the computer's files engine (Fx2.swift), 0: none
    private var queuedBytes = 0 // sent but not yet written (file sending waits while it is high)
    // Resume (move): the session's key from welcome, and the socket being opened to take over.
    private var resumeKey = "" { didSet { resumeLock.lock(); hasKey = !resumeKey.isEmpty; resumeLock.unlock() } }
    private var hasKey = false
    private let resumeLock = NSLock()
    // The computer said how to resume this session (any thread).
    var resumable: Bool { resumeLock.lock(); defer { resumeLock.unlock() }; return hasKey }
    private var pending: (task: URLSessionWebSocketTask, address: String, ble: Bool, done: (Bool) -> Void)?
    private let qLock = NSLock()

    // Quiet links (shared/quiet.js, #143): while nothing is live here and the computer says the same
    // (`idle {on}`), the session stops pinging every second: one ping every quietPing, closed after
    // quietTimeout of silence. A message sent while quiet is followed by one ping (a probe): no answer
    // within the timeout and the socket closes (and the session comes back). Messages don't end the
    // quiet; busyHere (Core: something live here), the computer saying busy or wake() do. A computer
    // that never says idle (an older app) keeps today's pings. Not through Bluetooth. All on q.
    static let quietIdle = "idle"
    static let quietActive: TimeInterval = 15
    static let quietPing: TimeInterval = 5 * 60
    static let quietTimeout: TimeInterval = 11 * 60
    var busyHere: () -> Bool = { false }
    var keepPinging = false
    private var peerIdle = false
    private var saidIdle = false
    private var lastUse = Date() // the session's start: active for quietActive
    private var probeAt: Date?
    private var probed = false
    private var wokeAt = Date.distantPast
    private var quietSince: Date?
    private var quietEnd = Date.distantPast
    private var quietPingAt = Date.distantPast

    // The app came to the front, a hold started or ended: look at the session now.
    func wake() { q.async { self.wokeAt = Date(); self.sayIdle() } }
    func nudge() { q.async { self.sayIdle() } }

    @discardableResult
    private func sayIdle() -> Bool {
        guard state == "connected" else { return false }
        let mine = !keepPinging && !busyHere() && Date().timeIntervalSince(max(lastUse, wokeAt)) >= Link.quietActive
        if mine != saidIdle, !viaBle, let text = encodeJSON(msg(Link.quietIdle, ["on": mine])) {
            write(text)
            saidIdle = mine
        }
        return mine
    }

    let list: String // the store's list its hosts go in: "hosts", or "peerHosts" (Peer.swift)

    init(list: String = "hosts") {
        self.list = list
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = false
        cfg.httpMaximumConnectionsPerHost = 6
        let dq = OperationQueue()
        dq.underlyingQueue = q
        dq.maxConcurrentOperationCount = 1
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: dq)
    }

    // ---- what the app asks for ----

    // force: even when already on this computer (moving onto the cable, or off it).
    func connect(_ h: Computer, force: Bool = false, ble: Bool = false) {
        q.async {
            if !force, self.ws != nil, self.host?.id == h.id, self.address == h.address, self.viaBle == ble, self.state == "connecting" || self.state == "connected" { return }
            self.closeSocket()
            self.viaBle = ble
            self.pair = nil
            self.host = h
            self.open("session", h.address, h.port, h.fp)
            self.setState("connecting", "")
        }
    }

    // The session onto another path (the network, or a Bluetooth pipe on 127.0.0.1) without ending it.
    // done(false): it stays where it was (the path didn't open in time, or nothing to resume).
    func move(to address: String, port: UInt16, ble: Bool, _ done: @escaping (Bool) -> Void) {
        q.async {
            guard self.state == "connected", self.mode == "session", !self.resumeKey.isEmpty, self.host != nil else {
                return DispatchQueue.main.async { done(false) }
            }
            self.dropPending(false)
            let a = address.contains(":") ? "[\(address)]" : address
            guard !address.isEmpty, port > 0, let url = URL(string: "wss://\(a):\(port)") else { return DispatchQueue.main.async { done(false) } }
            let t = self.session.webSocketTask(with: url)
            t.maximumMessageSize = Proto.maxPayload
            self.pending = (t, address, ble, done)
            t.resume()
            self.receivePending(t)
            self.q.asyncAfter(deadline: .now() + (ble ? 20 : 8)) {
                if self.pending?.task === t { NSLog("TwinDesk: the move to %@ didn’t answer in time", address); self.dropPending(false) }
            }
        }
    }

    private func dropPending(_ ok: Bool) {
        guard let p = pending else { return }
        pending = nil
        if !ok { p.task.cancel(with: .goingAway, reason: nil) }
        DispatchQueue.main.async { p.done(ok) }
    }

    private func receivePending(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] r in
            guard let self = self else { return }
            self.q.async {
                guard let p = self.pending, p.task === t else { return }
                guard case .success(let m) = r else { return self.dropPending(false) }
                var text: String?
                if case .string(let s) = m { text = s } else if case .data(let d) = m { text = String(data: d, encoding: .utf8) }
                guard let o = text.flatMap(decodeJSON) else { return self.receivePending(t) }
                if o.str("t") == Proto.T.welcome, (o["resumed"] as? Bool) == true { return self.promote(t) }
                if o.str("t") == Proto.T.error { return self.dropPending(false) }
                self.receivePending(t)
            }
        }
    }

    // welcome {resumed}: the computer sends on the new socket from now on; so do we. The old one closes.
    private func promote(_ t: URLSessionWebSocketTask) {
        guard let p = pending, p.task === t, state == "connected" else { return dropPending(false) }
        let old = ws
        ws = t
        address = p.address
        viaBle = p.ble
        lastRx = Date()
        quietSince = nil
        saidIdle = false
        receive(t)
        old?.cancel(with: .normalClosure, reason: nil)
        NSLog("TwinDesk: the session moved to %@", p.ble ? "Bluetooth" : p.address)
        dropPending(true)
        sayIdle()
        changed()
    }

    func disconnect() {
        q.async {
            if self.state == "connected" { self.raw(msg(Proto.T.bye)) }
            self.closeSocket()
            self.setState("idle", "")
        }
    }

    // nonce: from the computer's QR code: no code to compare, only Allow there.
    // ble: through a Bluetooth pipe on 127.0.0.1 (the longer timeout).
    func startPairing(address: String, port: UInt16, name: String, nonce: String = "", ble: Bool = false) {
        q.async {
            self.closeSocket()
            self.viaBle = ble
            self.host = nil
            self.pairNonce = nonce
            self.pair = PairState(phase: "connecting", address: address, port: port, name: name, qr: !nonce.isEmpty)
            self.open("pair", address, port, nil)
            self.changed()
        }
    }

    func confirmCode() {
        q.async {
            guard var p = self.pair, p.phase == "code", self.mode == "pair" else { return }
            self.raw(msg(Proto.T.pairConfirm))
            p.phase = "waiting"
            self.pair = p
            self.changed()
        }
    }

    func cancelPairing() {
        q.async {
            guard let p = self.pair else { return }
            if self.mode == "pair" && p.phase != "failed" { self.raw(msg(Proto.T.pairCancel)) }
            self.pair = nil
            if self.mode == "pair" { self.closeSocket() }
            self.changed()
        }
    }

    @discardableResult
    func send(_ m: JSON) -> Bool {
        guard state == "connected", let text = encodeJSON(m) else { return false }
        q.async { if self.quietSince != nil && self.probeAt == nil { self.probeAt = Date() }; self.write(text) }
        return true
    }

    // Bytes waiting to go (file.chunk waits while it's over a megabyte).
    func queued() -> Int { qLock.lock(); defer { qLock.unlock() }; return queuedBytes }

    // ---- socket ----

    private func open(_ m: String, _ address: String, _ port: UInt16, _ fp: String?) {
        mode = m
        nw = ""
        seenFp = ""
        lastCode = nil
        pinFp = fp
        self.address = address
        let h = address.contains(":") ? "[\(address)]" : address
        // No address (a computer never seen on a network): nothing to open; URLSession throws on a URL
        // without a host.
        guard !address.isEmpty, port > 0, let url = URL(string: "wss://\(h):\(port)"), url.host?.isEmpty == false else {
            ws = nil
            return q.async { self.onClose("No address for the computer") }
        }
        let t = session.webSocketTask(with: url)
        t.maximumMessageSize = Proto.maxPayload
        ws = t
        t.resume()
        receive(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] r in
            guard let self = self else { return }
            self.q.async {
                guard t === self.ws else { return }
                switch r {
                case .success(let m):
                    if case .string(let s) = m { self.onText(s) }
                    else if case .data(let d) = m, let s = String(data: d, encoding: .utf8) { self.onText(s) }
                    self.receive(t)
                case .failure(let e):
                    self.onClose((e as NSError).domain == NSURLErrorDomain && (e as NSError).code == NSURLErrorServerCertificateUntrusted ? "identity" : e.localizedDescription)
                }
            }
        }
    }

    private func write(_ text: String) {
        guard let t = ws else { return }
        let n = text.utf8.count
        qLock.lock(); queuedBytes += n; qLock.unlock()
        t.send(.string(text)) { [weak self] _ in
            guard let self = self else { return }
            self.qLock.lock(); self.queuedBytes -= n; self.qLock.unlock()
        }
    }

    private func raw(_ m: JSON) { if let s = encodeJSON(m) { write(s) } }

    // Self-signed certificates: the fingerprint is the identity (pinned once paired). The same check
    // serves the fast files' HTTPS requests (Files), which go through this session too.
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { return completionHandler(.performDefaultHandling, nil) }
        guard let fp = Self.leafFingerprint(trust) else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        let pin = pinFp ?? host?.fp
        if mode == "pair" && pinFp == nil { seenFp = fp }
        else if let pin = pin, !pin.isEmpty, pin != fp {
            NSLog("TwinDesk: identity changed (%@ ≠ %@)", fp, pin)
            lastCode = "identity"
            return completionHandler(.cancelAuthenticationChallenge, nil)
        } else { seenFp = fp }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    static func leafFingerprint(_ trust: SecTrust) -> String? {
        var leaf: SecCertificate?
        if #available(iOS 15.0, macOS 12.0, *) {
            leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        }
        guard let c = leaf else { return nil }
        return Proto.sha256(SecCertificateCopyData(c) as Data).hex
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        if let p = pending, webSocketTask === p.task, let h = host {
            let hello = msg(Proto.T.hello, ["v": Proto.version, "id": store.deviceId, "name": store.deviceName, "os": Proto.os,
                                            "token": h.token, "resume": resumeKey])
            if let s = encodeJSON(hello) { webSocketTask.send(.string(s)) { _ in } }
            return
        }
        guard webSocketTask === ws else { return }
        lastRx = Date()
        if mode == "pair" {
            nw = Proto.randomHex(16)
            var start = msg(Proto.T.pairStart, ["v": Proto.version, "id": store.deviceId, "name": store.deviceName, "os": Proto.os,
                                                "commit": Proto.commitOf(nw)])
            if !pairNonce.isEmpty { start["wired"] = pairNonce }
            raw(start)
            pair?.phase = "starting"
            changed()
            return
        }
        hello()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === ws else { return }
        onClose(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let p = pending, task === p.task { return dropPending(false) }
        guard task === ws else { return }
        onClose(lastCode == "identity" ? "identity" : error?.localizedDescription)
    }

    private func hello() {
        guard let h = host else { return }
        raw(msg(Proto.T.hello, ["v": Proto.version, "id": store.deviceId, "name": store.deviceName, "os": Proto.os,
                                "token": h.token, "fx": 1, "fx2": 1]))
        helloTimer?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, self.state != "connected" else { return }
            self.message = tr("No answer")
            self.ws?.cancel(with: .goingAway, reason: nil)
        }
        helloTimer = w
        q.asyncAfter(deadline: .now() + self.timeout, execute: w)
    }

    private func onText(_ text: String) {
        guard let m = decodeJSON(text) else { return }
        let t = m.str("t")
        lastRx = Date()
        switch t {
        case Proto.T.pairNonce: return onNonce(m)
        case Proto.T.pairOk: return onPairOk(m)
        case Proto.T.pairCancel: return pairFailed(tr("Pairing was cancelled on the computer."))
        case Proto.T.welcome: return onWelcome(m)
        case Proto.T.error: return onError(m)
        case Proto.T.ping:
            if state == "connected" { raw(msg(Proto.T.pong, ["ts": m["ts"] ?? NSNull()])) }
            return
        case Proto.T.pong:
            if let ts = m["ts"] as? NSNumber { rttMs = max(0, Int(Date().timeIntervalSince1970 * 1000) - ts.intValue) }
            return
        case Link.quietIdle:
            if state == "connected" { peerIdle = (m["on"] as? Bool) == true }
            return
        default: break
        }
        if state == "connected" { events?.linkMessage(t, m) }
    }

    private func onNonce(_ m: JSON) {
        guard var p = pair else { return }
        let nonce = m.str("nonce", max: 200)
        guard mode == "pair", !nw.isEmpty, Proto.isHex(nonce, min: 32, max: 128), nonce.count % 2 == 0 else {
            return pairFailed(tr("The computer sent a bad pairing message."))
        }
        raw(msg(Proto.T.pairReveal, ["nonce": nw]))
        p.phase = "code"
        p.code = Proto.sasCode(fp: seenFp, nw: nw, nm: nonce)
        if p.qr {
            raw(msg(Proto.T.pairConfirm))
            p.phase = "waiting"
        }
        pair = p
        changed()
    }

    private func onPairOk(_ m: JSON) {
        guard let p = pair, mode == "pair", p.phase == "waiting" else { return }
        let token = m.str("token")
        let id = m.str("macId", max: 128)
        guard !token.isEmpty, !id.isEmpty else { return pairFailed(tr("The computer sent a bad pairing message.")) }
        let name = m.str("macName", max: 64)
        let h = Computer(id: id, name: name.isEmpty ? p.name : name, os: m.str("os").isEmpty ? "mac" : m.str("os"),
                     address: p.address, port: p.port, fp: seenFp, token: token, lastSeen: Date().timeIntervalSince1970)
        store.putHost(findable(h), list)
        pair = nil
        mode = "session"
        host = h
        pinFp = h.fp
        setState("connecting", "")
        hello()
    }

    // What's saved of a computer reached through the cable or a Bluetooth pipe (127.0.0.1, and the
    // pipe's own port): where it was last seen on a network instead, else 127.0.0.1 on the session's
    // port (the cable's, if it's plugged in). Saving the pipe's address made every later Connect go
    // to it, off the cable too, until the computer was forgotten and paired again.
    private func findable(_ h: Computer) -> Computer {
        guard h.address == "127.0.0.1" else { return h }
        var w = h
        if let old = store.host(h.id, list), old.address != "127.0.0.1", !old.address.isEmpty {
            w.address = old.address
            w.port = old.port
        } else {
            w.port = Proto.port
        }
        return w
    }

    private func onWelcome(_ m: JSON) {
        guard mode == "session", state != "connected", var h = host else { return }
        helloTimer?.cancel()
        let name = m.str("macName", max: 64)
        if !name.isEmpty { h.name = name }
        h.lastSeen = Date().timeIntervalSince1970
        if address != "127.0.0.1" { h.address = address }
        host = h
        store.putHost(findable(h), list)
        if list == "hosts" { store.lastHostId = h.id }
        rttMs = nil
        resumeKey = m.str("resume", max: 64)
        let fx = m.str("fx", max: 64)
        fxToken = Proto.isHex(fx, min: 32, max: 32) ? fx : ""
        let p2 = m.obj("fx2")?["port"] as? NSNumber
        fx2Port = p2.map { $0.intValue > 0 && $0.intValue < 65536 ? UInt16($0.intValue) : 0 } ?? 0
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + Proto.pingInterval, repeating: Proto.pingInterval)
        peerIdle = false
        saidIdle = false
        quietSince = nil
        quietEnd = .distantPast
        probeAt = nil
        probed = false
        lastUse = Date()
        t.setEventHandler { [weak self] in
            guard let self = self, let w = self.ws else { return }
            let now = Date()
            let mine = self.sayIdle()
            // Quiet (both ends idle, on the network): a ping every few minutes, a long silence limit.
            if mine && self.peerIdle && !self.viaBle {
                if self.quietSince == nil { self.quietSince = now; NSLog("TwinDesk: link quiet") }
                if let p = self.probeAt { // something went out while quiet: is anyone there?
                    if self.lastRx >= p { self.probeAt = nil; self.probed = false }
                    else if !self.probed {
                        self.probed = true
                        self.quietPingAt = now
                        self.raw(msg(Proto.T.ping, ["ts": Int(now.timeIntervalSince1970 * 1000)]))
                        return
                    } else if now.timeIntervalSince(p) > Proto.timeout {
                        NSLog("TwinDesk: no answer on a quiet link, closing")
                        self.message = tr("Stopped answering")
                        w.cancel(with: .goingAway, reason: nil)
                        self.onClose(nil)
                        return
                    } else { return }
                }
                if now.timeIntervalSince(self.lastRx) > Link.quietTimeout {
                    NSLog("TwinDesk: silent on a quiet link, closing")
                    self.message = tr("Stopped answering")
                    w.cancel(with: .goingAway, reason: nil)
                    self.onClose(nil)
                } else if now.timeIntervalSince(max(self.quietPingAt, self.quietSince!)) >= Link.quietPing {
                    self.quietPingAt = now
                    self.raw(msg(Proto.T.ping, ["ts": Int(now.timeIntervalSince1970 * 1000)]))
                }
                return
            }
            if self.quietSince != nil { self.quietSince = nil; self.quietEnd = now; self.probeAt = nil; self.probed = false; NSLog("TwinDesk: link active") }
            let quiet = now.timeIntervalSince(max(self.viaBle ? max(self.lastRx, self.bleRx()) : self.lastRx, self.quietEnd))
            if quiet > self.timeout {
                NSLog("TwinDesk: socket silent for %.1f s, closing", quiet)
                self.message = tr("Stopped answering")
                w.cancel(with: .goingAway, reason: nil)
                self.onClose(nil)
            } else {
                self.raw(msg(Proto.T.ping, ["ts": Int(Date().timeIntervalSince1970 * 1000)]))
            }
        }
        t.resume()
        pinger = t
        setState("connected", "")
        events?.linkWelcome(h, m)
    }

    private func onError(_ m: JSON) {
        let code = m.str("code")
        lastCode = code
        if mode == "pair" {
            let known = [Proto.E.pairRefused: tr("Pairing was refused."), Proto.E.pairTimeout: tr("Pairing timed out."),
                         Proto.E.busy: tr("That computer is busy pairing with another device."),
                         Proto.E.versionMismatch: tr("That computer runs a different TwinDesk version. Update both.")]
            return pairFailed(known[code] ?? tr("Pairing failed ({code}).", ["code": code]))
        }
        let name = host?.name ?? tr("The computer")
        switch code {
        case Proto.E.badToken: message = tr("{name} forgot this {device}. Pair again.", ["name": name, "device": Device.word])
        case Proto.E.busy: message = m.str("message").isEmpty ? tr("Busy with another device") : m.str("message")
        case Proto.E.replaced: message = m.str("message").isEmpty ? tr("Another device connected") : m.str("message")
        case Proto.E.released: message = tr("Disconnected from {name}", ["name": name])
        case Proto.E.asleep: message = tr("{name} is asleep", ["name": name])
        default: message = tr("Closed ({code})", ["code": code])
        }
        if code == Proto.E.badToken, let h = host { store.forgetHost(h.id, list) }
    }

    private func pairFailed(_ error: String) {
        guard var p = pair else { return }
        p.phase = "failed"
        p.error = error
        p.code = ""
        pair = p
        closeSocket()
        changed()
    }

    private func onClose(_ failure: String?) {
        guard ws != nil || state == "connected" || state == "connecting" || pair != nil else { return }
        pinger?.cancel(); pinger = nil
        helloTimer?.cancel()
        ws = nil
        fxToken = ""
        fx2Port = 0
        resumeKey = ""
        dropPending(false)
        if mode == "pair" {
            if let p = pair, p.phase != "failed" {
                pairFailed(p.phase == "connecting" ? tr("Couldn’t connect to {address}{reason}.", ["address": p.address, "reason": failure.map { " (\($0))" } ?? ""]) : tr("The connection closed."))
            }
            return
        }
        let was = state
        if failure == "identity" {
            setState("failed", tr("{name} looks different now. Forget it and pair again.", ["name": host?.name ?? tr("The computer")]))
        } else {
            if message.isEmpty, let f = failure { message = f }
            setState(was == "connected" || was == "connecting" ? "idle" : was, message)
        }
        if let h = host, was == "connected" || was == "connecting" { events?.linkClosed(h, lastCode) }
    }

    private func closeSocket() {
        pinger?.cancel(); pinger = nil
        helloTimer?.cancel()
        let w = ws
        ws = nil
        fxToken = ""
        fx2Port = 0
        resumeKey = ""
        dropPending(false)
        let wasConnected = state == "connected"
        if wasConnected { state = "idle" }
        w?.cancel(with: .normalClosure, reason: nil)
        if wasConnected, let h = host { events?.linkClosed(h, "local") }
    }

    private func setState(_ s: String, _ m: String) {
        state = s
        message = m
        changed()
    }

    private func changed() { events?.linkChanged() }

    // ---- fast files (fx): the file's bytes as one HTTPS stream on the session's port ----

    // A request for /twindesk/fx/<id>, or nil when fast files can't be used (no token, Bluetooth). On
    // the network, the cable, a Wi-Fi Direct group or a hotspot (this phone's or the computer's) alike,
    // as the computers' fastfile.js usable(); anything wrong before a byte: file.chunk (Files.swift).
    func fxRequest(_ id: String, method: String) -> URLRequest? {
        guard state == "connected", !viaBle, !fxToken.isEmpty, let h = host else { return nil }
        let a = address.contains(":") ? "[\(address)]" : address
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        guard let url = URL(string: "https://\(a):\(h.port)\(Proto.fxPath)\(enc)") else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue(fxToken, forHTTPHeaderField: Proto.fxHeader)
        r.timeoutInterval = 30
        return r
    }

    // Where fast files v2 go (Fx2.swift), or nil when they can't (no engine there, Bluetooth). Anything
    // wrong before a byte: the fx way, then file.chunk (Files.swift).
    func fx2Target() -> Fx2.To? {
        guard state == "connected", !viaBle, !fxToken.isEmpty, fx2Port > 0, let h = host, !h.fp.isEmpty else { return nil }
        return Fx2.To(host: address, port: fx2Port, fp: h.fp, token: fxToken)
    }

    // An HTTPS request to the session's computer (its port), e.g. the screen's stream.
    func sessionRequest(_ path: String, method: String) -> URLRequest? {
        guard state == "connected", let h = host else { return nil }
        let a = address.contains(":") ? "[\(address)]" : address
        guard let url = URL(string: "https://\(a):\(h.port)\(path)") else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = method
        return r
    }

    // The session's URLSession: its certificate check pins the computer for fx too.
    var urlSession: URLSession { session }
}
