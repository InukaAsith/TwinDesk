// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The session through the USB cable (mac/iosnet.js there). A Mac reaches a cabled iPhone only by
// connecting to a port on it (usbmuxd), so it keeps a few connections open to ours (47820), each
// saying which Mac it is ("TDUSB1 <id> <name>"). Here, the Mac's ports are mirrored on 127.0.0.1:
// the session's (47800), the WebRTC relay's (47802) and the files engine's: a connection to one
// takes a waiting cable connection, says "OPEN <port>" on it, and the two are joined. So Link
// connects to wss://127.0.0.1:47800 with the same pinned certificate and token as over Wi-Fi, and
// the screen, files and everything else go through the cable.
//   Plugged in (the Mac's connections arrive): the session moves onto the cable, or starts on it.
//   Unplugged: they close, the session drops and comes back over Wi-Fi by itself.
import Foundation
import Network

final class Usb: Feature {
    static let appPort: UInt16 = 47820
    static let relayPort: UInt16 = 47802

    private let q = DispatchQueue(label: "td.usb")
    private var listener: NWListener?
    private var locals: [UInt16: NWListener] = [:]
    private var waiting: [(conn: NWConnection, mac: String)] = [] // q only
    private var pendingLocal: [(NWConnection, UInt16, Date)] = [] // q only: local connections waiting for a cable one
    // q only: the computer 127.0.0.1 is meant to reach (the session's, or the one being paired): only
    // its cable connections are joined, so a session saved at 127.0.0.1 (paired through the cable or
    // Bluetooth) never reaches another computer that's on the cable now (its TLS would refuse it as
    // "looks different now"). nil: whichever computer is on the cable.
    private var want: String?
    private(set) var computerId: String? // main: a paired computer on the cable
    private(set) var computerName: String?
    // main: a computer on the cable this device isn't paired with yet (Pair on Connection's USB card:
    // pairing through the cable, the code compared as over Wi-Fi, any network or none).
    private(set) var unpaired: (id: String, name: String)?
    private var lastSeen = Date.distantPast
    private var droppedAt = Date.distantPast // main: when a session on the cable last failed
    var ready: Bool { computerId != nil }

    override init(_ core: Core) {
        super.init(core)
        q.async { self.listenCable() }
        for p in [Proto.port, Self.relayPort] { q.async { self.listenLocal(p) } }
    }

    // The files engine's port (welcome fx2) is mirrored too, once known.
    func mirror(_ port: UInt16) { q.async { if self.locals[port] == nil { self.listenLocal(port) } } }

    // ---- the Mac's side: connections that arrive through the cable ----

    private func listenCable() {
        let p = NWParameters.tcp
        p.allowLocalEndpointReuse = true
        guard let l = try? NWListener(using: p, on: NWEndpoint.Port(rawValue: Self.appPort)!) else {
            q.asyncAfter(deadline: .now() + 5) { self.listenCable() }
            return
        }
        l.newConnectionHandler = { [weak self] c in self?.arrived(c) }
        l.stateUpdateHandler = { [weak self] st in
            if case .failed = st { l.cancel(); self?.q.asyncAfter(deadline: .now() + 3) { self?.listenCable() } }
        }
        l.start(queue: q)
        listener = l
    }

    // A Mac's connection: its greeting, then it waits here until we need one.
    private func arrived(_ c: NWConnection) {
        c.start(queue: q)
        readLine(c) { [weak self] line in
            guard let self = self else { return }
            let parts = (line ?? "").split(separator: " ", maxSplits: 2).map(String.init)
            guard parts.count >= 2, parts[0] == "TDUSB1", Proto.isHex(parts[1], min: 8, max: 128) || parts[1].count <= 128 else { c.cancel(); return }
            let id = parts[1]
            let name = parts.count > 2 ? (parts[2].removingPercentEncoding ?? parts[2]) : "Mac"
            // A computer this iPhone isn't paired with waits too, for Pair (the session's TLS pins a
            // paired one anyway; an unpaired one only gets pair.start, its code shown on both).
            self.waiting.append((c, id))
            c.stateUpdateHandler = { [weak self, weak c] st in
                guard let self = self, let c = c else { return }
                switch st {
                case .failed, .cancelled, .waiting:
                    if case .waiting = st { c.cancel() } // its path went away (the cable out)
                    self.waiting.removeAll { $0.conn === c }
                    self.checkGone()
                default: break
                }
            }
            self.lastSeen = Date()
            DispatchQueue.main.async { self.seen(id, name) }
            self.servePending()
        }
    }

    private func readLine(_ c: NWConnection, _ done: @escaping (String?) -> Void) {
        var buf = Data()
        func more() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 256) { d, _, end, err in
                if let d = d { buf.append(d) }
                if let i = buf.firstIndex(of: 10) { return done(String(data: buf[..<i], encoding: .utf8)) }
                if end || err != nil || buf.count > 256 { return done(nil) }
                more()
            }
        }
        more()
    }

    // No connection from the Mac for a while: the cable is out (or TwinDesk there stopped).
    private func checkGone() {
        q.asyncAfter(deadline: .now() + 6) {
            guard self.waiting.isEmpty else { return }
            DispatchQueue.main.async {
                guard self.computerId != nil || self.unpaired != nil else { return }
                NSLog("TwinDesk: USB cable gone")
                self.computerId = nil
                self.computerName = nil
                self.unpaired = nil
                self.core.changed()
            }
        }
    }

    // ---- our side: 127.0.0.1:<the Mac's port> ----

    private func listenLocal(_ port: UInt16) {
        let p = NWParameters.tcp
        p.allowLocalEndpointReuse = true
        p.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        guard let l = try? NWListener(using: p) else { return }
        l.newConnectionHandler = { [weak self] c in
            guard let self = self else { return c.cancel() }
            c.start(queue: self.q)
            self.pendingLocal.append((c, port, Date()))
            self.servePending()
        }
        l.stateUpdateHandler = { [weak self] st in
            if case .failed = st { l.cancel(); self?.locals[port] = nil; self?.q.asyncAfter(deadline: .now() + 3) { self?.listenLocal(port) } }
        }
        l.start(queue: q)
        locals[port] = l
    }

    // Each local connection takes a waiting cable one ("OPEN <port>"), or waits a few seconds for one.
    private func servePending() {
        pendingLocal.removeAll { c in
            if Date().timeIntervalSince(c.2) > 5 { c.0.cancel(); return true }
            return false
        }
        while !pendingLocal.isEmpty, let i = waiting.firstIndex(where: { want == nil || $0.mac == want }) {
            let (local, port, _) = pendingLocal.removeFirst()
            let cable = waiting.remove(at: i).conn
            cable.stateUpdateHandler = nil
            cable.send(content: "OPEN \(port)\n".data(using: .utf8), completion: .contentProcessed { _ in })
            join(local, cable)
            checkGone() // the Mac opens another one; if it doesn't, the cable is out
        }
        if !pendingLocal.isEmpty { q.asyncAfter(deadline: .now() + 0.5) { self.servePending() } }
    }

    private func join(_ a: NWConnection, _ b: NWConnection) {
        let end = { a.cancel(); b.cancel() }
        func pump(_ from: NWConnection, _ to: NWConnection) {
            from.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { d, _, done, err in
                if let d = d, !d.isEmpty {
                    to.send(content: d, completion: .contentProcessed { e in
                        if e != nil { end() } else if !done && err == nil { pump(from, to) }
                    })
                    if done || err != nil { end() }
                    return
                }
                if done || err != nil { end() } else { pump(from, to) }
            }
        }
        for c in [a, b] {
            c.stateUpdateHandler = { st in
                switch st { case .failed, .cancelled: end(); default: break }
            }
        }
        pump(a, b)
        pump(b, a)
    }

    // ---- the session moves onto the cable ----

    private func seen(_ id: String, _ name: String) {
        guard core.store.host(id) != nil else {
            if unpaired?.id != id || unpaired?.name != name { unpaired = (id, name); NSLog("TwinDesk: %@ on the USB cable, not paired", name); core.changed() }
            return
        }
        unpaired = nil
        let was = computerId
        computerId = id
        computerName = name
        if was != id { NSLog("TwinDesk: on the USB cable to %@", name); core.changed() }
        // A session on the cable just failed: not straight back onto it (a cable that's in but not
        // working would keep the network from being tried); Connect or the next plug-in still does.
        if Date().timeIntervalSince(droppedAt) < 20 { return }
        moveOn()
    }

    // A session through the cable closed or never opened. Unplugged, the cable's waiting connections
    // often don't fail here (nothing comes back through usbmuxd to say so), so computerId would stay
    // set and every reconnect, Connect included, would go to 127.0.0.1 again. So they're all dropped
    // and the cable counts as gone: the Mac opens new ones within a moment if it's still plugged in
    // (shared/iosnet.js refills its pool when one closes), and the session comes back over Wi-Fi or
    // Bluetooth meanwhile.
    // Main, from Core.linkClosed (not for a session closed here on purpose: a move, Disconnect).
    func sessionFailed() {
        guard computerId != nil || unpaired != nil else { return }
        NSLog("TwinDesk: the session on the cable closed: the cable counts as gone until the Mac's back")
        droppedAt = Date()
        computerId = nil
        computerName = nil
        unpaired = nil
        q.async {
            let all = self.waiting
            self.waiting.removeAll()
            for w in all { w.conn.stateUpdateHandler = nil; w.conn.cancel() }
        }
        core.changed()
    }

    func moveOn() {
        guard let id = computerId, core.store.flag("usb.auto", true), core.link.pair == nil else { return }
        if core.link.wired && core.link.host?.id == id { return }
        // Disconnected on purpose: only a new plug-in brings it back.
        if core.state == "idle" && core.store.lastHostId == nil && core.link.host?.id == id { return }
        if core.connected && core.link.host?.id != id { return } // with another computer: left alone
        guard let h = core.store.host(id) else { return }
        core.connectWired(h)
    }

    // Main: what 127.0.0.1 reaches from now on (Core, before each session or pairing through it).
    func aim(_ id: String) { q.async { self.want = id } }

    // Pair on the USB card: the pairing through the cable (127.0.0.1, as the session goes).
    func pair() {
        guard let u = unpaired, core.link.pair == nil else { return }
        aim(u.id)
        core.link.startPairing(address: "127.0.0.1", port: Proto.port, name: u.name)
    }

    // Paired through the cable: it's ours now, and the session that follows is on it.
    private func adopt(_ host: Computer) {
        guard unpaired?.id == host.id else { return }
        unpaired = nil
        computerId = host.id
        computerName = host.name
        core.changed()
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        adopt(host)
        if let fx2 = m.obj("fx2"), let p = fx2["port"] as? NSNumber, p.intValue > 0, p.intValue < 65536 { mirror(UInt16(p.intValue)) }
    }
}
