// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Discovery on UDP 47801, as on the computers and the Android app, with one difference: iOS lets an
// app send broadcasts only with Apple's multicast entitlement, which a sideloaded app doesn't get.
// So the iPhone finds computers by unicast: a probe to every address of its Wi-Fi or Ethernet
// subnet (the computers answer a probe with their beacon, to the sender), and its own beacons go
// to each computer it knows of, so they list it. A computer's invite (its phone tile clicked) is
// unicast to the address it saw us at, which works as it does on Android.
import Foundation
import Darwin

struct Found: Identifiable, Equatable {
    let id: String
    var name: String
    var os: String
    var address: String
    var port: UInt16
    var fp: String
    var lastSeen: Date
    var invited: Bool
}

final class Discovery {
    private let q = DispatchQueue(label: "td.discovery")
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var beaconTimer: DispatchSourceTimer?
    private var lastSweep = Date.distantPast
    // Connected with TwinDesk off screen (kept running by Location or silent audio): a beacon a minute,
    // no subnet sweeps. The beacons every 2 s woke the Wi-Fi radio all day (#143); the session doesn't
    // need them and the computer lists a connected phone anyway. Back to 2 s as soon as it isn't.
    static let slowInterval: TimeInterval = 60
    private var slow = false // q only
    private(set) var found: [String: Found] = [:] // q only; read with list()
    // Android phones with TwinDesk (their beacon's `ap`, Peer.swift): port is their phone server's
    // (`phost`), 0 while they don't host. They answer our probes; their beacons are broadcasts.
    private var phones: [String: Found] = [:] // q only
    var peerOn: () -> Bool = { false }
    var peerPort: () -> UInt16 = { 0 } // ours while we host (Peer.swift), in our beacon as `phost`
    var onPeer: (Found, JSON) -> Void = { _, _ in } // another phone's peer.* (main)
    var error = ""

    var self_: () -> (id: String, name: String) = { ("", "") }
    var known: () -> [String] = { [] } // the addresses of paired computers: beacons go there too
    var onChange: () -> Void = {}
    var onInvite: (Found) -> Void = { _ in }
    var wantSweep: () -> Bool = { true } // not connected, or the app is open: look for computers

    func start() { q.async { self.open() } }

    func stop() {
        q.async {
            self.beaconTimer?.cancel(); self.beaconTimer = nil
            self.source?.cancel(); self.source = nil
        }
    }

    func list() -> [Found] {
        q.sync { found.values.sorted { ($0.invited ? 0 : 1, $0.name) < ($1.invited ? 0 : 1, $1.name) } }
    }

    func get(_ id: String) -> Found? { q.sync { found[id] } }

    func phoneList() -> [Found] { q.sync { phones.values.sorted { $0.name < $1.name } } }
    func phone(_ id: String) -> Found? { q.sync { phones[id] } }
    func setPhonePort(_ id: String, _ address: String, _ port: UInt16) {
        q.async {
            guard var f = self.phones[id] else { return }
            f.address = address; f.port = port; f.lastSeen = Date()
            self.phones[id] = f
            self.changed()
        }
    }
    // A packet to one address (peer.ask to a phone).
    func sendTo(_ m: JSON, _ address: String) { q.async { self.send(m, to: address) } }

    func clearInvite(_ id: String) {
        q.async {
            if var f = self.found[id], f.invited { f.invited = false; self.found[id] = f; self.changed() }
        }
    }

    // Look now (the app came to the front, the network changed, Pull to refresh).
    func refresh() { q.async { self.lastSweep = .distantPast; self.tick() } }

    func setSlow(_ on: Bool) {
        q.async {
            guard on != self.slow else { return }
            self.slow = on
            NSLog("TwinDesk: discovery %@", on ? "slow (off screen)" : "every 2 s")
            if on { self.beaconTimer?.schedule(deadline: .now() + Discovery.slowInterval, repeating: Discovery.slowInterval, leeway: .seconds(10)) }
            else { self.beaconTimer?.schedule(deadline: .now(), repeating: Proto.beaconInterval) }
        }
    }

    // A computer at this address, typed in or from a QR code: ask it directly.
    func probe(_ address: String) { q.async { self.send(self.probeMsg(), to: address) } }

    // ---- socket ----

    private func open() {
        if fd >= 0 { return }
        let s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard s >= 0 else { error = "Can’t open a socket"; return }
        var yes: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(s, SOL_SOCKET, SO_REUSEPORT, &yes, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(s, SOL_SOCKET, SO_BROADCAST, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = Proto.discoveryPort.bigEndian
        addr.sin_addr = in_addr(s_addr: INADDR_ANY)
        let ok = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if ok != 0 {
            close(s)
            error = "Can’t listen on UDP \(Proto.discoveryPort)"
            q.asyncAfter(deadline: .now() + 5) { self.open() }
            return
        }
        let flags = fcntl(s, F_GETFL)
        _ = fcntl(s, F_SETFL, flags | O_NONBLOCK)
        fd = s
        error = ""
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: q)
        src.setEventHandler { [weak self] in self?.receive() }
        src.setCancelHandler { close(s) }
        src.resume()
        source = src
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now(), repeating: slow ? Discovery.slowInterval : Proto.beaconInterval)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        beaconTimer = t
    }

    private func tick() {
        let me = beaconMsg()
        // Broadcast where iOS allows it (it doesn't without the multicast entitlement: an error, ignored).
        for b in Self.interfaces().map({ $0.broadcast }) { send(me, to: b) }
        var targets = Set(known())
        for f in found.values { targets.insert(f.address) }
        for a in targets where !a.isEmpty && a != "127.0.0.1" { send(me, to: a) }
        if peerOn() { // they hear us only this way (no broadcast here), and answer probes
            let p = probeMsg()
            for f in phones.values { send(me, to: f.address); send(p, to: f.address) }
        }
        // The subnet sweep: every 10 s while looking, else every 60 s (a computer that moved).
        let every: TimeInterval = wantSweep() ? 10 : 60
        if !slow, Date().timeIntervalSince(lastSweep) >= every {
            lastSweep = Date()
            sweep()
        }
        prune()
    }

    private func sweep() {
        let p = probeMsg()
        for i in Self.interfaces() {
            for a in i.hosts where a != i.address { send(p, to: a) }
        }
    }

    private func beaconMsg() -> JSON {
        let me = self_()
        var m: JSON = ["t": Proto.T.beacon, "v": Proto.version, "id": me.id, "name": me.name, "os": Proto.os,
                       "role": "guest", "port": Int(Proto.port), "fp": ""]
        if peerOn() { m["ap"] = 1; let p = peerPort(); if p > 0 { m["phost"] = Int(p) } } // a phone for other phones
        return m
    }

    private func probeMsg() -> JSON { ["t": Proto.T.probe, "v": Proto.version, "id": self_().id] }

    private func send(_ m: JSON, to address: String, port: UInt16 = Proto.discoveryPort) {
        guard fd >= 0, let text = encodeJSON(m) else { return }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        guard inet_pton(AF_INET, address, &addr.sin_addr) == 1 else { return }
        let bytes = Array(text.utf8)
        _ = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bytes.withUnsafeBufferPointer { b in sendto(fd, b.baseAddress, b.count, 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
        }
    }

    private func receive() {
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            var from = sockaddr_in()
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            let n = withUnsafeMutablePointer(to: &from) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, &buf, buf.count, 0, $0, &len) }
            }
            if n <= 0 { return }
            var ip = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            var a = from.sin_addr
            inet_ntop(AF_INET, &a, &ip, socklen_t(INET_ADDRSTRLEN))
            let address = String(cString: ip)
            let port = UInt16(bigEndian: from.sin_port)
            guard let text = String(bytes: buf[0..<n], encoding: .utf8), let m = decodeJSON(text) else { continue }
            handle(m, address, port)
        }
    }

    private func handle(_ m: JSON, _ address: String, _ port: UInt16) {
        let me = self_().id
        let id = m.str("id", max: 128)
        guard m.int("v") == Proto.version, !id.isEmpty, id != me else { return }
        let t = m.str("t")
        if t == Proto.T.probe { return send(beaconMsg(), to: address, port: port) }
        if t.hasPrefix("peer.") { // an Android phone (Peer.swift)
            guard peerOn() else { return }
            var f = phones[id] ?? Found(id: id, name: m.str("name", max: 100).isEmpty ? "Phone" : m.str("name", max: 100), os: "android",
                                        address: address, port: 0, fp: "", lastSeen: Date(), invited: false)
            f.address = address
            DispatchQueue.main.async { self.onPeer(f, m) }
            return
        }
        guard t == Proto.T.beacon || t == Proto.T.invite else { return }
        let os = m.str("os").isEmpty ? "mac" : m.str("os")
        if os == "android" || os == Proto.os { // a phone for other phones (Peer.swift)
            guard t == Proto.T.beacon, m.int("ap") == 1, peerOn() else { return }
            let old = phones[id]
            let pp = m.int("phost", 0)
            let name = m.str("name", max: 100)
            let f = Found(id: id, name: name.isEmpty ? (os == "ios" ? "iPhone" : "Phone") : name, os: os, address: address,
                          port: (1...65535).contains(pp) ? UInt16(pp) : 0, fp: "", lastSeen: Date(), invited: false)
            phones[id] = f
            if old == nil || old!.name != f.name || old!.address != f.address || old!.port != f.port { changed() }
            return
        }
        if t == Proto.T.beacon && (m["role"] as? String ?? "host") != "host" { return }
        let old = found[id]
        let p = m.int("port", Int(Proto.port))
        let name = m.str("name", max: 100)
        let f = Found(id: id, name: name.isEmpty ? (os == "mac" ? "Mac" : os == "linux" ? "Linux" : "PC") : name, os: os,
                      address: address, port: (1...65535).contains(p) ? UInt16(p) : Proto.port,
                      fp: Proto.normFingerprint(m["fp"] as? String), lastSeen: Date(),
                      invited: (old?.invited ?? false) || t == Proto.T.invite)
        found[id] = f
        if t == Proto.T.invite { DispatchQueue.main.async { self.onInvite(f) } }
        if old == nil || old!.name != f.name || old!.address != f.address || old!.invited != f.invited { changed() }
    }

    private func prune() {
        let now = Date()
        let stalePhones = phones.values.filter { now.timeIntervalSince($0.lastSeen) > Proto.deviceStale * 2 }.map { $0.id }
        for id in stalePhones { phones.removeValue(forKey: id) }
        if !stalePhones.isEmpty { changed() }
        let stale = found.values.filter { now.timeIntervalSince($0.lastSeen) > Proto.deviceStale }.map { $0.id }
        if stale.isEmpty { return }
        for id in stale { found.removeValue(forKey: id) }
        changed()
    }

    private func changed() { DispatchQueue.main.async { self.onChange() } }

    // ---- interfaces ----

    struct Iface {
        let name: String
        let address: String
        let broadcast: String
        let hosts: [String] // every other address of its subnet (at most a /22: 1022)
        var wired: Bool { !name.hasPrefix("en0") && name.hasPrefix("en") } // en0 is Wi-Fi; an Ethernet adapter is en2, en3…
    }

    // Wi-Fi (en0), Ethernet adapters (en2…) and this phone's hotspot (bridge100), IPv4.
    static func interfaces() -> [Iface] {
        var out: [Iface] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return out }
        defer { freeifaddrs(list) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let i = p {
            defer { p = i.pointee.ifa_next }
            let flags = Int32(i.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0, let sa = i.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  let nm = i.pointee.ifa_netmask else { continue }
            let name = String(cString: i.pointee.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
            let a = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            var mask = nm.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            if mask == 0 { continue }
            if mask < 0xFFFF_FC00 { mask = 0xFFFF_FF00 } // a bigger subnet: only our /24 of it
            let net = a & mask
            let bc = net | ~mask
            var hosts: [String] = []
            if bc > net + 1 { for h in (net + 1)..<bc { hosts.append(ipString(h)) } }
            out.append(Iface(name: name, address: ipString(a), broadcast: ipString(bc), hosts: hosts))
        }
        return out
    }

    static func ipString(_ v: UInt32) -> String { "\(v >> 24 & 255).\(v >> 16 & 255).\(v >> 8 & 255).\(v & 255)" }

    // A wired Ethernet adapter is up: shown on the Overview ("Ethernet"), and preferred for the session.
    static var hasEthernet: Bool { interfaces().contains { $0.wired } }
}
