// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone's screen on the computer, Meet-style (the whole screen, every app). The broadcast
// extension (Broadcast/SampleHandler.swift) encodes it and hands it to us on 127.0.0.1:47830; we
// send it to the computer as an Android phone does without wireless debugging (Mirror.kt; the
// computer's shared/nativescreen.js), so its phone window shows it:
//   phone.mirror {open}                         to the computer: shared from here (the person
//                                               started it on the iPhone), open its window / closed
//   phone.mirror.want {on, key, maxSize, bitrate, fps} | {on, sync}   from it
//   phone.mirror.state {on, waiting, error, w, h, sw, sh, key}        to it
//   POST /twindesk/mirror (x-twindesk-mirror: key), the session's HTTPS port: scrcpy's packets
import Foundation
import Network
import UIKit

final class Mirror: Feature, URLSessionTaskDelegate, StreamDelegate {
    static let port: UInt16 = 47830

    private var listener: NWListener?
    private var ext: NWConnection? // the broadcast extension, while it shares
    private var rx = Data()
    private(set) var sharing = false // the extension is running
    private(set) var size: (w: Int, h: Int, sw: Int, sh: Int)?
    private var want: JSON? // the computer's phone.mirror.want, while its window is open
    private var key = ""
    private var session: URLSession?
    private var upload: URLSessionUploadTask?
    private var out: OutputStream?
    private var pendingIn: InputStream?
    private let io = DispatchQueue(label: "td.mirror")
    private var backlog = [Data]() // io only: packets waiting for room in the body stream
    private var sessionPacket: Data? // the size packet: first in every new request
    private var configPacket: Data? // SPS/PPS: next, so the window can decode from the first frame
    var peerTap: ((Data) -> Void)? // a phone watching (Peer.swift): every packet, as it comes

    override init(_ core: Core) {
        super.init(core)
        startListening()
    }

    // ---- the extension ----

    private func startListening() {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
        params.allowLocalEndpointReuse = true
        guard let l = try? NWListener(using: params) else { return }
        l.newConnectionHandler = { [weak self] c in DispatchQueue.main.async { self?.accept(c) } }
        l.stateUpdateHandler = { [weak self] st in
            if case .failed = st { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self?.listener = nil; self?.startListening() } }
        }
        l.start(queue: .main)
        listener = l
    }

    private func accept(_ c: NWConnection) {
        ext?.cancel()
        ext = c
        rx = Data()
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled: DispatchQueue.main.async { if self?.ext === c { self?.extGone() } }
            default: break
            }
        }
        c.start(queue: .main)
        sharing = true
        Background.shared.apply() // the app stays up while it relays the screen
        read(c)
        core.changed()
        if !core.connected {
            // Nothing to share with: the broadcast stops itself and says why.
            sendExt(["stop": 1])
            return
        }
        if want == nil {
            // Started here: the computer opens its window and asks (phone.mirror.want).
            core.send(msg("phone.mirror", ["open": true]))
        } else {
            configure()
        }
    }

    private func read(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, err in
            guard let self = self, self.ext === c else { return }
            if let d = data { self.rx.append(d); self.parse() }
            if done || err != nil { self.extGone(); return }
            self.read(c)
        }
    }

    private func parse() {
        while rx.count >= 5 {
            let s = rx.startIndex
            let n = Int(rx[s + 1]) << 24 | Int(rx[s + 2]) << 16 | Int(rx[s + 3]) << 8 | Int(rx[s + 4])
            guard rx.count >= 5 + n else { return }
            let type = rx[s]
            let body = rx.subdata(in: (s + 5)..<(s + 5 + n))
            rx = rx.subdata(in: (s + 5 + n)..<rx.endIndex)
            if type == 2 { packet(body); continue }
            guard type == 1, let m = (try? JSONSerialization.jsonObject(with: body)) as? JSON else { continue }
            if m["stopped"] != nil { extGone(); return }
            if m["hello"] != nil {
                size = (m.int("w"), m.int("h"), m.int("sw"), m.int("sh"))
                sendState()
            }
        }
    }

    private func extGone() {
        guard sharing else { return }
        sharing = false
        Background.shared.apply()
        ext?.cancel()
        ext = nil
        size = nil
        endUpload()
        if core.connected {
            core.send(msg("phone.mirror.state", ["on": false, "key": key]))
            core.send(msg("phone.mirror", ["open": false]))
        }
        core.changed()
    }

    private func sendExt(_ m: JSON) {
        guard let c = ext, let d = try? JSONSerialization.data(withJSONObject: m) else { return }
        var f = Data([1])
        let n = UInt32(d.count)
        f.append(contentsOf: [UInt8(n >> 24), UInt8(n >> 16 & 255), UInt8(n >> 8 & 255), UInt8(n & 255)])
        f.append(d)
        c.send(content: f, completion: .idempotent)
    }

    // A phone wants it (Peer.swift): the encoder on, at its size, a keyframe now.
    func peerWant(_ maxSize: Int) {
        let w = want
        sendExt(["maxSize": w?.int("maxSize") ?? maxSize, "bitrate": w?.int("bitrate", 8_000_000) ?? 6_000_000, "fps": min(60, w?.int("fps", 30) ?? 30), "want": 1, "sync": 1])
    }

    // Stop sharing (the app's button): the extension ends the broadcast.
    func stop() {
        sendExt(["stop": 1])
        extGone()
    }

    // ---- the computer ----

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == "phone.mirror.want" else { return false }
        if !m.bool("on") {
            want = nil
            endUpload()
            if sharing { sendExt(["stop": 1]) }
            return true
        }
        if m.bool("sync") {
            sendExt(["sync": 1])
            return true
        }
        want = m
        key = m.str("key", max: 64)
        if sharing { configure() }
        else {
            // The computer asked first (its Show Phone Screen): Start is the person's, on this iPhone.
            core.send(msg("phone.mirror.state", ["on": false, "waiting": true, "key": key]))
            Notifier.shared.shareAsk(core.link.host?.name ?? "The computer")
        }
        return true
    }

    override func onClosed() {
        want = nil
        endUpload()
        if sharing { sendExt(["stop": 1]) }
    }

    private func configure() {
        guard let w = want else { return }
        sendExt(["maxSize": w.int("maxSize"), "bitrate": w.int("bitrate", 8_000_000), "fps": min(60, w.int("fps", 30)), "want": 1, "sync": 1])
        startUpload()
        sendState()
    }

    private func sendState() {
        guard want != nil, let s = size else { return }
        core.send(msg("phone.mirror.state", ["on": true, "key": key, "w": s.w, "h": s.h, "sw": s.sw, "sh": s.sh]))
    }

    // ---- the stream: one long POST, its body fed as packets come ----

    private func startUpload() {
        endUpload()
        guard var req = core.link.sessionRequest("/twindesk/mirror", method: "POST") else {
            core.send(msg("phone.mirror.state", ["on": false, "error": "the connection closed", "key": key]))
            return
        }
        req.setValue(key, forHTTPHeaderField: "x-twindesk-mirror")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 3600
        var i: InputStream?
        var o: OutputStream?
        Stream.getBoundStreams(withBufferSize: 1 << 20, inputStream: &i, outputStream: &o)
        guard let ins = i, let outs = o else { return }
        pendingIn = ins
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 3600
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        session = s
        io.async {
            outs.delegate = self
            outs.schedule(in: .current, forMode: .default)
            outs.open()
            self.out = outs
            self.backlog = [self.sessionPacket, self.configPacket].compactMap { $0 }
            self.pump()
            // The stream's run loop: io's thread for as long as the body is fed.
            while self.out === outs { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.25)) }
        }
        let t = s.uploadTask(withStreamedRequest: req)
        upload = t
        t.resume()
    }

    private func endUpload() {
        upload?.cancel()
        upload = nil
        session?.invalidateAndCancel()
        session = nil
        io.async {
            self.out?.close()
            self.out = nil
            self.backlog.removeAll()
        }
    }

    // A packet from the extension: kept if it's the size or SPS/PPS, then on to the computer.
    private func packet(_ p: Data) {
        guard p.count >= 12 else { return }
        peerTap?(p)
        if p[p.startIndex] & 0x80 != 0 { sessionPacket = p; configPacket = nil }
        else if p[p.startIndex] & 0x40 != 0 { configPacket = p } // bit 62: config
        io.async {
            guard self.out != nil else { return }
            // Behind by more than ~2 s of picture: drop what's waiting and ask for a keyframe.
            if self.backlog.reduce(0, { $0 + $1.count }) > 4 << 20 {
                self.backlog = [self.configPacket].compactMap { $0 }
                DispatchQueue.main.async { self.sendExt(["sync": 1]) }
            }
            self.backlog.append(p)
            self.pump()
        }
    }

    private func pump() {
        guard let o = out else { return }
        while !backlog.isEmpty, o.hasSpaceAvailable {
            let d = backlog[0]
            let n = d.withUnsafeBytes { o.write($0.bindMemory(to: UInt8.self).baseAddress!, maxLength: d.count) }
            if n <= 0 { return }
            if n < d.count { backlog[0] = d.subdata(in: (d.startIndex + n)..<d.endIndex) } else { backlog.removeFirst() }
        }
    }

    func stream(_ s: Stream, handle e: Stream.Event) {
        if e == .hasSpaceAvailable { pump() }
        if e == .errorOccurred || e == .endEncountered { DispatchQueue.main.async { self.endUpload() } }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping (InputStream?) -> Void) {
        completionHandler(pendingIn)
        pendingIn = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let trust = challenge.protectionSpace.serverTrust, let fp = Link.leafFingerprint(trust), fp == core.link.host?.fp else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        DispatchQueue.main.async {
            guard self.upload === task else { return }
            NSLog("TwinDesk: screen stream ended: %@", error?.localizedDescription ?? "done")
            self.upload = nil
            // Still sharing and still wanted: a new request (the window keeps its decoder).
            if self.sharing, self.want != nil, self.core.connected {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { if self.upload == nil && self.sharing { self.configure() } }
            }
        }
    }
}
