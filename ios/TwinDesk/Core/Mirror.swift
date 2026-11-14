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
// When the computer asks (its Show screen), it names its AirPlay receiver too (want.airplay, turned
// on there): the app asks here, Share Screen or Screen Mirroring to it (UI/MirrorGuide.swift shows
// where that is), and phone.mirror.state {on: false, airplay: true} closes its window for AirPlay's.
import Foundation
import Network
import UIKit

final class Mirror: Feature {
    static let port: UInt16 = 47830

    private var listener: NWListener?
    private var ext: NWConnection? // the broadcast extension, while it shares
    private var rx = Data()
    private(set) var sharing = false { didSet { if sharing { asking = false } } } // the extension is running
    var asking = false // the computer asked to see this screen: the app asks how (MirrorAskSheet)
    private(set) var airplayTo: String? // the computer's AirPlay receiver (Screen Mirroring lists it so)
    // A Mac whose AirPlay Receiver is off (want.airplayOff): the sheet says where to turn it on there.
    private(set) var airplayOff = false
    // Where Screen Mirroring goes: the receiver the computer named, else the computer's own name.
    var airplayName: String { airplayTo ?? core.link.host?.name ?? tr("the computer") }
    private(set) var size: (w: Int, h: Int, sw: Int, sh: Int)?
    private var want: JSON? // the computer's phone.mirror.want, while its window is open
    private var key = ""
    private var upload: NWConnection? // io only: the stream to the computer, while it goes
    private var uploadGen = 0 // main: which stream is current (an old one's end restarts nothing)
    private var inflight = 0 // io only: bytes handed to the connection, not sent yet
    private var skipToKey = false // io only: frames dropped, so the rest wait for the next keyframe
    private let io = DispatchQueue(label: "td.mirror")
    private var sessionPacket: Data? // the size packet: first in every new request
    private var configPacket: Data? // SPS/PPS: next, so the window can decode from the first frame
    var peerTap: ((Data) -> Void)? // a phone watching (Peer.swift): every packet, as it comes
    // Share was tapped and iOS's sheet is up (it takes the app out of focus): the session stays on
    // Wi-Fi meanwhile (Core.networkBusy), so the picture has a way once the broadcast starts.
    var starting: Bool { startUntil > Date() }
    private var startUntil = Date.distantPast
    func willStart() { startUntil = Date().addingTimeInterval(30) }
    private var openPending = false // shared while the session was on Bluetooth: told once it's on the network
    private var uploadPending = false // asked for while on Bluetooth: the stream starts once on the network
    private var graceWork: DispatchWorkItem? // the session dropped while sharing: the broadcast waits this long

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
        startUntil = .distantPast
        sendExt(["ack": 1]) // the extension knows the app has it (else it ends the broadcast, never recording for nothing)
        Background.shared.apply() // the app stays up while it relays the screen
        read(c)
        core.changed()
        // A phone holds the session (Peer, phone to phone: no computer then): the screen goes to it,
        // once it asks (screen.start) or at once if it asked before Share Screen was started.
        if core.peer.connected {
            core.peer.shareStarted()
            return
        }
        if !core.connected {
            // Nothing to share with: a session coming back soon still gets it (onWelcome), else the
            // broadcast stops itself and says why.
            waitForSession()
            return
        }
        announce()
    }

    // Shared from here: the computer opens its window and asks (phone.mirror.want). On Bluetooth the
    // picture has no way: back onto the network first (told then, networkBack), or after a few
    // seconds anyway (the computer says what it needs).
    private func announce() {
        guard sharing, core.connected else { return }
        if want != nil { return configure() }
        if core.link.viaBle {
            openPending = true
            core.needNetwork()
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self = self, self.openPending, self.sharing, self.core.connected else { return }
                self.openPending = false
                self.core.send(msg("phone.mirror", ["open": true]))
            }
            return
        }
        openPending = false
        core.send(msg("phone.mirror", ["open": true]))
    }

    // The session moved from Bluetooth back onto the network (Core.offBle): what waited for it now.
    func networkBack() {
        guard sharing, core.connected, !core.link.viaBle else { return }
        if openPending { openPending = false; core.send(msg("phone.mirror", ["open": true])) }
        if uploadPending || want != nil { uploadPending = false; startUpload() } // a stream on the old way: again on this one
    }

    private func waitForSession() {
        graceWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, self.sharing, !self.core.connected, !self.core.peer.connected else { return }
            self.sendExt(["stop": 1])
        }
        graceWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: w)
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
        graceWork?.cancel()
        graceWork = nil
        openPending = false
        uploadPending = false
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
        // Shared off screen and done: onto Bluetooth now (Core.backgrounded waited for it).
        DispatchQueue.main.async { if !self.core.inFront { self.core.backgrounded() } }
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
            asking = false
            core.changed()
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
        let air = m.str("airplay", max: 100)
        if !air.isEmpty { airplayTo = air }
        airplayOff = m.bool("airplayOff")
        if sharing { configure() }
        else {
            // The computer asked first (its Show Phone Screen): Start is the person's, on this iPhone.
            core.send(msg("phone.mirror.state", ["on": false, "waiting": true, "key": key]))
            asking = true
            core.changed()
            Notifier.shared.shareAsk(core.link.host?.name ?? tr("The computer"), airplay: airplayTo)
        }
        return true
    }

    // Screen Mirroring (AirPlay) in place of Share Screen: the computer's waiting window closes,
    // its AirPlay receiver shows the screen.
    func useAirPlay() {
        asking = false
        if want != nil && !sharing {
            core.send(msg("phone.mirror.state", ["on": false, "airplay": true, "key": key]))
            want = nil
        }
        Notifier.shared.cancel("share")
        core.changed()
    }

    // Not now: the computer's window says so and closes.
    func decline() {
        asking = false
        if want != nil && !sharing {
            core.send(msg("phone.mirror.state", ["on": false, "error": "Not shared from the \(Device.word)", "key": key]))
            want = nil
        }
        Notifier.shared.cancel("share")
        core.changed()
    }

    // The session dropped (a Wi-Fi blip, the computer restarting): the broadcast waits a little for it
    // to come back (onWelcome) before it stops, and encodes nothing meanwhile.
    override func onClosed() {
        asking = false
        want = nil
        openPending = false
        uploadPending = false
        endUpload()
        if sharing { sendExt(["want": 0]); waitForSession() }
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        graceWork?.cancel()
        graceWork = nil
        if sharing { announce() }
    }

    private func configure() {
        guard let w = want else { return }
        sendExt(["maxSize": w.int("maxSize"), "bitrate": w.int("bitrate", 8_000_000), "fps": min(60, w.int("fps", 30)), "want": 1, "sync": 1])
        if core.link.viaBle { uploadPending = true; core.needNetwork() } // no picture through Bluetooth (networkBack)
        else { startUpload() }
        sendState()
    }

    private func sendState() {
        guard want != nil, let s = size else { return }
        core.send(msg("phone.mirror.state", ["on": true, "key": key, "w": s.w, "h": s.h, "sw": s.sw, "sh": s.sh]))
    }

    // ---- the stream: one long POST, its body fed as packets come ----
    //
    // A TLS connection of our own (the computer's certificate pinned as the session's), the request
    // written by hand with a chunked body: each packet one chunk, sent as it comes. (It was a
    // URLSession upload fed through bound streams whose run loop held the queue the packets came in
    // on, so after the first two packets nothing more reached the computer.)

    private func startUpload() {
        endUpload()
        guard let req = core.link.sessionRequest("/twindesk/mirror", method: "POST"), let u = req.url, let host = u.host, let port = u.port,
              let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            core.send(msg("phone.mirror.state", ["on": false, "error": "the connection closed", "key": key]))
            return
        }
        let pin = core.link.seenFp.isEmpty ? (core.link.host?.fp ?? "") : core.link.seenFp
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, done in
            let fp = Link.leafFingerprint(sec_trust_copy_ref(trust).takeRetainedValue())
            done(fp != nil && (pin.isEmpty || fp == pin))
        }, io)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let c = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: NWParameters(tls: tls, tcp: tcp))
        uploadGen += 1
        let gen = uploadGen
        let head = "POST /twindesk/mirror HTTP/1.1\r\nHost: \(host):\(port)\r\nContent-Type: application/octet-stream\r\n"
            + "x-twindesk-mirror: \(key)\r\nTransfer-Encoding: chunked\r\n\r\n"
        let first = [sessionPacket, configPacket].compactMap { $0 }
        c.stateUpdateHandler = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .ready:
                c.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
                self.upload = c
                self.inflight = 0
                self.skipToKey = true // from a keyframe on (the extension is asked for one)
                for p in first { self.chunk(c, p) }
                DispatchQueue.main.async { self.sendExt(["sync": 1]) }
                self.drain(c, gen)
            case .failed(let e):
                NSLog("TwinDesk: screen stream: %@", e.localizedDescription)
                c.cancel()
                self.uploadEnded(c, gen)
            case .cancelled: self.uploadEnded(c, gen)
            default: break
            }
        }
        c.start(queue: io)
    }

    // The computer's answer: read and dropped; its end is the stream's.
    private func drain(_ c: NWConnection, _ gen: Int) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] _, _, done, err in
            if done || err != nil { c.cancel(); self?.uploadEnded(c, gen); return }
            self?.drain(c, gen)
        }
    }

    // io: gone (the computer closed it, the network dropped). Still sharing and still wanted: again.
    private func uploadEnded(_ c: NWConnection, _ gen: Int) {
        if upload === c { upload = nil }
        DispatchQueue.main.async {
            guard gen == self.uploadGen else { return }
            NSLog("TwinDesk: screen stream ended")
            if self.sharing, self.want != nil, self.core.connected {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { if gen == self.uploadGen && self.sharing && self.want != nil { self.startUpload() } }
            }
        }
    }

    private func endUpload() {
        uploadGen += 1
        io.async {
            guard let c = self.upload else { return }
            self.upload = nil
            c.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in c.cancel() })
        }
    }

    // io: one packet as one chunk.
    private func chunk(_ c: NWConnection, _ p: Data) {
        var d = Data(String(p.count, radix: 16).utf8)
        d.append(contentsOf: [13, 10])
        d.append(p)
        d.append(contentsOf: [13, 10])
        let n = d.count
        inflight += n
        c.send(content: d, completion: .contentProcessed { [weak self] _ in self?.io.async { self?.inflight -= n } })
    }

    // A packet from the extension: kept if it's the size or SPS/PPS, then on to the computer.
    private func packet(_ p: Data) {
        guard p.count >= 12 else { return }
        peerTap?(p)
        let b = p[p.startIndex]
        if b & 0x80 != 0 { sessionPacket = p; configPacket = nil }
        else if b & 0x40 != 0 { configPacket = p } // bit 62: config
        io.async {
            guard let c = self.upload else { return }
            let special = b & 0xC0 != 0 // the size or SPS/PPS: always
            let key = b & 0x20 != 0 // bit 61: a keyframe
            // Behind by more than ~2 s of picture: frames dropped until a keyframe (asked for now).
            if !special && self.inflight > 4 << 20 {
                if !self.skipToKey { self.skipToKey = true; DispatchQueue.main.async { self.sendExt(["sync": 1]) } }
                return
            }
            if !special && self.skipToKey { if key { self.skipToKey = false } else { return } }
            self.chunk(c, p)
        }
    }
}
