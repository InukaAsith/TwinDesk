// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bluetooth LE (Android's Ble.kt, the Mac's mac-helper Ble.swift): the Mac advertises the TwinDesk
// service; we connect to it, read INFO (its beacon), and stay connected to the ones we're paired
// with, saying hello on CTRL. That link is what keeps TwinDesk going on an iPhone:
//   • iOS keeps a central's connection (and its pending reconnects) while the app is suspended, and
//     wakes the app for what comes on it (bluetooth-central); state restoration brings it back even
//     after iOS ended it. The Mac's invite on CTRL wakes us to bring the session back.
//   • Off the Mac's network, the session itself goes through it: a pipe on 127.0.0.1 here (Link
//     connects its WSS there, as for the USB cable), its bytes written to UP and back from DOWN. TLS,
//     the pinned certificate and the token are the session's own, end to end.
import Foundation
import CoreBluetooth
import Network

final class Ble: Feature, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let serviceId = CBUUID(string: "B7F30001-2C4E-4D1A-9A57-3E8C2F6D0A91")
    static let infoId = CBUUID(string: "B7F30002-2C4E-4D1A-9A57-3E8C2F6D0A91")
    static let ctrlId = CBUUID(string: "B7F30003-2C4E-4D1A-9A57-3E8C2F6D0A91")
    static let upId = CBUUID(string: "B7F30004-2C4E-4D1A-9A57-3E8C2F6D0A91")
    static let downId = CBUUID(string: "B7F30005-2C4E-4D1A-9A57-3E8C2F6D0A91")
    static let maxUpInFlight = 24

    private final class Conn {
        let p: CBPeripheral
        var hostId = ""
        var ctrl: CBCharacteristic?
        var up: CBCharacteristic?
        var ready = false
        var guest = false // a computer not paired yet, kept linked while Connection looks (pairing through it)
        var name = ""
        // The pipe: the local socket the session's WSS connected to, and its bytes on the way up.
        var listener: NWListener?
        var sock: NWConnection?
        var gen = 0
        var inflight = 0
        var reading = false
        init(_ p: CBPeripheral) { self.p = p }
    }

    private let q = DispatchQueue(label: "td.ble")
    private var cm: CBCentralManager?
    private var conns: [UUID: Conn] = [:] // q only
    private var tried: [UUID: Date] = [:] // unpaired ones read lately: not again for a while
    private(set) var radio = "off" // main: on, off, unauthorized, unsupported
    private(set) var near: [String: String] = [:] // main: host id -> name, linked and paired
    private(set) var unpaired: [String: String] = [:] // main: host id -> name, linked, not paired (Pair over Bluetooth)
    private var looking = false // q: Connection is on screen: unpaired computers are kept linked, for Pair
    // q: when the scan last (re)started. iOS reports a peripheral once per scan, so one that was read
    // and let go (unpaired then, a failed connect) is seen again only after a fresh scan.
    private var scanAt = Date.distantPast
    private var rescan: DispatchSourceTimer?
    private var downAt = Date.distantPast
    private let lock = NSLock()

    var on: Bool { core.store.flag("ble", true) }
    // When bytes last came through a pipe (Link's liveness counts them: a big message takes a while).
    var lastDown: Date { lock.lock(); defer { lock.unlock() }; return downAt }

    // Peripheral → host id, to reconnect without scanning (retrievePeripherals).
    private var known: [String: String] {
        get { (UserDefaults.standard.dictionary(forKey: "ble.known") as? [String: String]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "ble.known") }
    }

    // Started once there's a computer to link to (asks for Bluetooth the first time).
    func start() {
        guard on, !core.store.hosts().isEmpty else { return }
        q.async {
            // Already up: a computer paired since is linked to (a stopped scan starts again).
            if let cm = self.cm { if cm.state == .poweredOn { self.relink(); self.scan() }; return }
            self.cm = CBCentralManager(delegate: self, queue: self.q, options: [
                CBCentralManagerOptionRestoreIdentifierKey: "td.ble",
                CBCentralManagerOptionShowPowerAlertKey: false,
            ])
        }
    }

    // Connection on screen: computers not paired yet are found over Bluetooth too, for Pair (two
    // devices on different networks, or none). The Bluetooth question comes up the first time.
    func look(_ on: Bool) {
        guard self.on else { return }
        q.async {
            self.looking = on
            if on {
                self.tried.removeAll()
                if self.cm == nil {
                    self.cm = CBCentralManager(delegate: self, queue: self.q, options: [
                        CBCentralManagerOptionRestoreIdentifierKey: "td.ble",
                        CBCentralManagerOptionShowPowerAlertKey: false,
                    ])
                    return
                }
            } else {
                // Off Connection: the unpaired ones go, unless a pairing is going through one.
                for c in self.conns.values where c.guest && c.sock == nil && c.listener == nil { self.drop(c) }
            }
            self.scan()
        }
    }

    func stop() {
        q.async {
            guard let cm = self.cm else { return }
            cm.stopScan()
            for c in self.conns.values { self.closePipe(c, tell: false); cm.cancelPeripheralConnection(c.p) }
            self.conns.removeAll()
            self.publish()
        }
    }

    func setOn(_ v: Bool) {
        core.store.setFlag("ble", v)
        if v { start() } else { stop() }
        core.changed()
    }

    func has(_ hostId: String) -> Bool { near[hostId] != nil }

    // ---- central ----

    func centralManagerDidUpdateState(_ cm: CBCentralManager) {
        let s: String
        switch cm.state {
        case .poweredOn: s = "on"
        case .unauthorized: s = "unauthorized"
        case .unsupported: s = "unsupported"
        default: s = "off"
        }
        DispatchQueue.main.async { self.radio = s; self.core.changed() }
        guard cm.state == .poweredOn else {
            for c in conns.values { closePipe(c, tell: false) }
            conns.removeAll()
            publish()
            return
        }
        relink()
        scan()
    }

    // The computers we linked to before: connected again directly (a pending connection never
    // times out, so it waits for them, in the background too). Restored ones (willRestoreState) too:
    // left as they came back, they'd sit in conns and keep didDiscover from ever linking them.
    private func relink() {
        guard let cm = cm, cm.state == .poweredOn else { return }
        let ids = known.keys.compactMap(UUID.init(uuidString:))
        for p in cm.retrievePeripherals(withIdentifiers: ids) where conns[p.identifier]?.ready != true { link(p) }
        for p in cm.retrieveConnectedPeripherals(withServices: [Self.serviceId]) where conns[p.identifier]?.ready != true { link(p) }
        for c in conns.values where !c.ready && !c.guest && c.p.state != .connecting { link(c.p) }
    }

    func centralManager(_ cm: CBCentralManager, willRestoreState dict: [String: Any]) {
        for p in (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]) ?? [] {
            p.delegate = self
            conns[p.identifier] = Conn(p)
        }
    }

    // Scanning (with the service, so it works in the background) while a paired computer isn't linked.
    private func scan() {
        guard let cm = cm, cm.state == .poweredOn else { return }
        let paired = Set(Store.shared.hosts().map { $0.id })
        let linked = Set(conns.values.filter { $0.ready }.map { $0.hostId })
        if paired.subtracting(linked).isEmpty && !looking {
            cm.stopScan()
            rescan?.cancel()
            rescan = nil
            return
        }
        // Started afresh now and then while something is still missing (see scanAt).
        if !cm.isScanning || Date().timeIntervalSince(scanAt) > 20 {
            cm.stopScan()
            cm.scanForPeripherals(withServices: [Self.serviceId], options: nil)
            scanAt = Date()
        }
        if rescan == nil {
            let t = DispatchSource.makeTimerSource(queue: q)
            t.schedule(deadline: .now() + 20, repeating: 20)
            t.setEventHandler { [weak self] in self?.scan() }
            t.resume()
            rescan = t
        }
    }

    func centralManager(_ cm: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        if let c = conns[p.identifier], c.ready || c.guest || p.state != .disconnected { return }
        if known[p.identifier.uuidString] == nil, let t = tried[p.identifier], Date().timeIntervalSince(t) < 15 { return }
        tried[p.identifier] = Date()
        link(p)
    }

    private func link(_ p: CBPeripheral) {
        let c = conns[p.identifier] ?? Conn(p)
        conns[p.identifier] = c
        p.delegate = self
        if p.state == .connecting { return } // asked already: it waits
        if p.state == .connected { p.discoverServices([Self.serviceId]) }
        else { cm?.connect(p, options: [CBConnectPeripheralOptionNotifyOnNotificationKey: false]) }
    }

    func centralManager(_ cm: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([Self.serviceId])
    }

    func centralManager(_ cm: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        gone(p, again: true)
    }

    func centralManager(_ cm: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        gone(p, again: true)
    }

    // A link went: its pipe with it; to a paired computer it's asked for again at once (it waits).
    private func gone(_ p: CBPeripheral, again: Bool) {
        let c = conns.removeValue(forKey: p.identifier)
        if let c = c { closePipe(c, tell: false) }
        if again, on, let id = known[p.identifier.uuidString], Store.shared.host(id) != nil { link(p) }
        publish()
        scan()
    }

    private func drop(_ c: Conn) {
        conns.removeValue(forKey: c.p.identifier)
        closePipe(c, tell: false)
        cm?.cancelPeripheralConnection(c.p)
        publish()
    }

    // ---- GATT ----

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = p.services?.first(where: { $0.uuid == Self.serviceId }) else {
            if let c = conns[p.identifier] { drop(c) }
            return
        }
        p.discoverCharacteristics([Self.infoId, Self.ctrlId, Self.upId, Self.downId], for: s)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        guard let c = conns[p.identifier], let info = s.characteristics?.first(where: { $0.uuid == Self.infoId }) else { return }
        c.ctrl = s.characteristics?.first { $0.uuid == Self.ctrlId }
        c.up = s.characteristics?.first { $0.uuid == Self.upId }
        p.readValue(for: info)
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor chr: CBCharacteristic, error: Error?) {
        guard let c = conns[p.identifier], let v = chr.value else { return }
        switch chr.uuid {
        case Self.infoId: info(c, v)
        case Self.downId:
            lock.lock(); downAt = Date(); lock.unlock()
            c.sock?.send(content: v, completion: .contentProcessed { [weak self] e in
                if e != nil { self?.q.async { self?.closePipe(c, tell: true) } }
            })
        case Self.ctrlId:
            guard let o = (try? JSONSerialization.jsonObject(with: v)) as? JSON else { return }
            switch o["op"] as? String {
            case "invite":
                let id = c.hostId
                NSLog("TwinDesk: invited over Bluetooth")
                DispatchQueue.main.async { self.core.bleInvite(id) }
            case "closed": closePipe(c, tell: false)
            default: break
            }
        default: break
        }
    }

    // INFO: the computer's beacon. Paired with it: listen on CTRL and DOWN, and say who we are.
    private func info(_ c: Conn, _ v: Data) {
        guard let o = (try? JSONSerialization.jsonObject(with: v)) as? JSON, let id = o["id"] as? String, !id.isEmpty else { return drop(c) }
        c.hostId = id
        c.name = String(((o["name"] as? String) ?? "").prefix(64))
        if c.name.isEmpty { c.name = "Computer" }
        guard Store.shared.host(id) != nil else {
            // Not ours: kept linked only while Connection looks, for Pair through it.
            guard looking else { return drop(c) }
            c.guest = true
            for chr in c.p.services?.first(where: { $0.uuid == Self.serviceId })?.characteristics ?? [] where chr.uuid == Self.ctrlId || chr.uuid == Self.downId {
                c.p.setNotifyValue(true, for: chr)
            }
            ctrl(c, ["op": "hello", "id": core.store.deviceId, "name": core.store.deviceName, "os": Proto.os])
            NSLog("TwinDesk: %@ over Bluetooth, not paired", c.name)
            return publish()
        }
        var k = known
        k[c.p.identifier.uuidString] = id
        known = k
        for chr in c.p.services?.first(where: { $0.uuid == Self.serviceId })?.characteristics ?? [] where chr.uuid == Self.ctrlId || chr.uuid == Self.downId {
            c.p.setNotifyValue(true, for: chr)
        }
        ctrl(c, ["op": "hello", "id": core.store.deviceId, "name": core.store.deviceName, "os": Proto.os])
        c.ready = true
        NSLog("TwinDesk: Bluetooth link to %@", (o["name"] as? String) ?? id)
        publish()
        scan()
        DispatchQueue.main.async { self.core.bleLinked(id) }
    }

    private func ctrl(_ c: Conn, _ o: JSON) {
        guard let chr = c.ctrl, let d = try? JSONSerialization.data(withJSONObject: o) else { return }
        c.p.writeValue(d, for: chr, type: .withResponse)
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor chr: CBCharacteristic, error: Error?) {
        guard chr.uuid == Self.upId, let c = conns[p.identifier], c.sock != nil else { return }
        c.inflight = max(0, c.inflight - 1)
        if error != nil { // a lost chunk breaks the session's TLS: this pipe is over
            NSLog("TwinDesk: Bluetooth UP write failed: the pipe closes")
            return closePipe(c, tell: true)
        }
        if !c.reading, c.inflight < Self.maxUpInFlight / 2, let s = c.sock { read(c, s, c.gen) }
    }

    private func publish() {
        var m: [String: String] = [:]
        var u: [String: String] = [:]
        for c in conns.values where c.ready { m[c.hostId] = Store.shared.host(c.hostId)?.name ?? "Computer" }
        for c in conns.values where c.guest { u[c.hostId] = c.name }
        DispatchQueue.main.async {
            if self.near != m || self.unpaired != u { self.near = m; self.unpaired = u; self.core.changed() }
        }
    }

    // Paired through Bluetooth (or with one linked here as unpaired): the link becomes a paired one.
    override func onWelcome(_ host: Computer, _ m: JSON) {
        q.async {
            guard let c = self.conns.values.first(where: { $0.guest && $0.hostId == host.id }) else {
                // Not linked as a guest (paired over Wi-Fi, Connection left): look for it now.
                self.tried.removeAll()
                self.relink()
                return self.scan()
            }
            c.guest = false
            c.ready = true
            var k = self.known
            k[c.p.identifier.uuidString] = host.id
            self.known = k
            NSLog("TwinDesk: Bluetooth link to %@", host.name)
            self.publish()
            self.scan()
        }
    }

    // ---- the pipe ----

    // A 127.0.0.1 port whose one connection goes to the computer with this id (nil: no link to it).
    func openPipe(_ hostId: String, _ done: @escaping (UInt16?) -> Void) {
        q.async {
            guard let c = self.conns.values.first(where: { ($0.ready || $0.guest) && $0.hostId == hostId }) else {
                self.scan()
                return DispatchQueue.main.async { done(nil) }
            }
            self.closePipe(c, tell: true)
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            guard let l = try? NWListener(using: params) else { return DispatchQueue.main.async { done(nil) } }
            c.listener = l
            var answered = false
            let answer = { (port: UInt16?) in
                if answered { return }
                answered = true
                DispatchQueue.main.async { done(port) }
            }
            l.stateUpdateHandler = { st in
                switch st {
                case .ready: answer(l.port?.rawValue)
                case .failed, .cancelled: answer(nil)
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] s in
                guard let self = self, c.listener === l else { return s.cancel() }
                l.cancel()
                c.listener = nil
                c.gen += 1
                c.sock = s
                c.inflight = 0
                let gen = c.gen
                s.stateUpdateHandler = { [weak self] st in
                    switch st {
                    case .failed, .cancelled: self?.q.async { if c.gen == gen { self?.closePipe(c, tell: true) } }
                    default: break
                    }
                }
                s.start(queue: self.q)
                self.ctrl(c, ["op": "open"])
                self.read(c, s, gen)
            }
            l.start(queue: self.q)
            self.q.asyncAfter(deadline: .now() + 15) { if c.listener === l { l.cancel(); c.listener = nil } }
        }
    }

    // The session's bytes to UP, in writes the link takes, a few in flight (acknowledged: one lost
    // byte would break the session's TLS).
    private func read(_ c: Conn, _ s: NWConnection, _ gen: Int) {
        guard c.sock === s, c.gen == gen, let up = c.up else { return }
        c.reading = true
        s.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] d, _, end, err in
            guard let self = self else { return }
            c.reading = false
            guard c.sock === s, c.gen == gen else { return }
            if let d = d, !d.isEmpty {
                let max = Swift.max(20, Swift.min(512, c.p.maximumWriteValueLength(for: .withResponse)))
                var i = 0
                while i < d.count {
                    let n = Swift.min(max, d.count - i)
                    c.p.writeValue(d.subdata(in: (d.startIndex + i)..<(d.startIndex + i + n)), for: up, type: .withResponse)
                    c.inflight += 1
                    i += n
                }
            }
            if end || err != nil { return self.closePipe(c, tell: true) }
            if c.inflight < Self.maxUpInFlight { self.read(c, s, gen) } // else: didWriteValueFor reads on
        }
    }

    private func closePipe(_ c: Conn, tell: Bool) {
        c.listener?.cancel()
        c.listener = nil
        guard let s = c.sock else { return }
        c.sock = nil
        c.gen += 1
        c.inflight = 0
        s.cancel()
        if tell, c.p.state == .connected { ctrl(c, ["op": "close"]) }
    }

    func piped(_ hostId: String) -> Bool {
        q.sync { conns.values.contains { $0.hostId == hostId && $0.sock != nil } }
    }
}
