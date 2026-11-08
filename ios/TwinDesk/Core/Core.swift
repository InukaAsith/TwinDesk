// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The app's one model: the session (Link), discovery, and the features on it. The UI observes it.
// Like android/…/Core.kt, the phone connects only when asked (Connect, an invite from the
// computer, a QR code) or to resume a session that dropped by accident (PHONE_GRACE_MS), plus one
// thing iOS needs: the last computer is reconnected to when the app wakes in the background.
import Foundation
import Combine

class Feature: NSObject {
    unowned let core: Core
    init(_ core: Core) { self.core = core; super.init() }
    func onWelcome(_ host: Computer, _ m: JSON) {}
    func onClosed() {}
    func onMessage(_ t: String, _ m: JSON) -> Bool { false }
}

final class Core: ObservableObject, LinkEvents {
    static let shared = Core()

    let store = Store.shared
    let link = Link()
    let discovery = Discovery()
    private(set) var features: [Feature] = []
    lazy var sync = PairSync(self)
    lazy var clip = Clip(self)
    lazy var notifs = Notifs(self)
    lazy var files = Files(self)
    lazy var fclip = FileClip(self)
    lazy var info = PhoneInfo(self)
    lazy var mirror = Mirror(self)
    lazy var screen = Screen(self)
    lazy var sound = PcSound(self)
    lazy var remote = Remote(self)
    lazy var media = PcMedia(self)
    lazy var dev = DevCtl(self)
    lazy var smb = Smb(self)
    lazy var hub = Hub(self)
    lazy var camera = Camera(self)
    lazy var usb = Usb(self)
    lazy var ble = Ble(self)
    lazy var shareIn = ShareIn(self)
    lazy var mic = Mic(self)
    lazy var peer = Peer(self) // Connect with Android: its own link, beside the computer's

    // Published copies for the UI (main thread).
    @Published private(set) var state = "idle"
    @Published private(set) var message = ""
    @Published private(set) var pair: PairState?
    @Published private(set) var host: Computer?
    @Published private(set) var rttMs: Int?
    @Published private(set) var nearby: [Found] = []
    @Published private(set) var hosts: [Computer] = []
    @Published var invite: Found?
    @Published private(set) var tick = 0 // features changed something: views redraw

    private var resumeUntil = Date.distantPast
    private var resumeHost: Computer?
    private var started = false

    var connected: Bool { state == "connected" }

    private init() {
        link.events = self
        discovery.self_ = { [unowned self] in (self.store.deviceId, self.store.deviceName) }
        discovery.known = { [unowned self] in self.store.hosts().map { $0.address } }
        discovery.wantSweep = { [unowned self] in !self.link.connected }
        discovery.onChange = { [unowned self] in self.refresh(); DispatchQueue.main.async { self.offBle(); self.ble.start() } }
        discovery.onInvite = { [unowned self] f in self.onInvite(f) }
        features = [sync, clip, notifs, files, fclip, info, mirror, screen, sound, remote, media, dev, smb, hub, camera, usb, ble, shareIn, mic]
        link.bleRx = { [unowned self] in self.ble.lastDown }
    }

    func start() {
        if started { return }
        started = true
        discovery.start()
        remote.watchControllers()
        ble.start()
        _ = peer
        refresh()
        Background.shared.apply()
    }

    // The app woke (foreground, or in the background by location / audio / an intent): back on the
    // last computer if it's around and we're not connected.
    func wake() {
        start()
        discovery.refresh()
        // Back in front after the session went onto Bluetooth (backgrounded): onto the cable or the network again.
        if link.viaBle, link.connected, let h = link.host {
            if usb.computerId == h.id, let fresh = store.host(h.id) { connectWired(fresh) } else { offBle() }
        }
        if link.state == "idle", link.pair == nil, let id = store.lastHostId, let h = store.host(id),
           store.flag("autoConnect", true) {
            if usb.computerId == id { connectWired(h) } else { connect(h) }
        }
    }

    func changed() { DispatchQueue.main.async { self.tick &+= 1 } }

    private func refresh() {
        let l = link
        let apply = {
            self.state = l.state
            self.message = l.message
            self.pair = l.pair
            self.host = l.host
            self.rttMs = l.rttMs
            self.nearby = self.discovery.list()
            self.hosts = self.store.hosts().sorted { $0.lastSeen > $1.lastSeen }
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }

    @discardableResult
    func send(_ m: JSON) -> Bool { link.send(m) }

    // ---- actions ----

    func connect(_ h: Computer) {
        if usb.computerId == h.id { return connectWired(h) } // on the cable to it: through the cable
        resumeUntil = .distantPast
        var h = h
        if let f = discovery.get(h.id) { h.address = f.address; h.port = f.port; store.putHost(h) }
        // Not seen on this network but linked over Bluetooth: the session through it.
        else if ble.has(h.id) { return connectBle(h) }
        link.connect(h)
    }

    // Through a Bluetooth pipe (Ble): the computer's port reached on 127.0.0.1 here.
    func connectBle(_ h: Computer) {
        resumeUntil = .distantPast
        ble.openPipe(h.id) { [weak self] port in
            guard let self = self else { return }
            guard let port = port else { return self.link.connect(h) } // no link after all: try the network
            var b = h
            b.address = "127.0.0.1"
            b.port = port
            NSLog("TwinDesk: session through Bluetooth")
            self.link.connect(b, force: true, ble: true)
        }
    }

    // The computer asked over Bluetooth (its invite on CTRL, which also wakes the app): back on it
    // unless we left it on purpose or are with another.
    func bleInvite(_ id: String) {
        guard let h = store.host(id), link.pair == nil, store.lastHostId == id || store.lastHostId == nil && store.flag("autoConnect", true) else { return }
        if link.host?.id == id && (link.state == "connected" || link.state == "connecting") { return }
        if link.connected { return }
        connect(h)
    }

    // Off the screen, iOS's own way (no location or silent audio keeping the app running): the session
    // moves onto the Bluetooth link, which iOS keeps while TwinDesk is suspended and wakes it for each
    // thing that comes on it (bluetooth-central), the computer's pings included, so the session lives
    // on. Not while the backups keep the app running (the network stays), the microphone is recording
    // (iOS keeps it running) or the screen is shared.
    func backgrounded() {
        guard Background.shared.enabled, link.connected, !link.viaBle, link.pair == nil, let h = link.host, ble.has(h.id),
              !Background.shared.active, !mic.running, !mirror.sharing else { return }
        NSLog("TwinDesk: off screen: the session onto Bluetooth")
        connectBle(h)
    }

    // On Bluetooth and the computer showed up on the network: the session moves back to it.
    private func offBle() {
        guard link.viaBle, link.connected, let h = link.host, let f = discovery.get(h.id), let saved = store.host(h.id) else { return }
        var w = saved
        w.address = f.address
        w.port = f.port
        store.putHost(w)
        NSLog("TwinDesk: back on the network from Bluetooth")
        link.connect(w, force: true)
    }

    // Onto the USB cable (Usb): the same computer at 127.0.0.1, the session moved there.
    func connectWired(_ h: Computer) {
        resumeUntil = .distantPast
        var w = h
        w.address = "127.0.0.1"
        w.port = Proto.port
        link.connect(w, force: true)
    }

    func disconnect() {
        resumeUntil = .distantPast
        store.lastHostId = nil // not back on our own until Connect again
        link.disconnect()
    }

    func pair(_ f: Found) {
        invite = nil
        discovery.clearInvite(f.id)
        if let h = store.host(f.id) { return connect(h) }
        link.startPairing(address: f.address, port: f.port, name: f.name)
    }

    func pairAddress(_ address: String) {
        let a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !a.isEmpty else { return }
        link.startPairing(address: a, port: Proto.port, name: a)
    }

    // twindesk://pair?id=…&n=<name>&a=<address,address>&p=<port>&k=<nonce> (the computer's QR code).
    @discardableResult
    func openURL(_ url: URL) -> Bool {
        if url.isFileURL {
            files.adopt(url)
            files.flushShares()
            if !connected { wake() }
            return true
        }
        guard url.scheme == "twindesk", url.host == "pair",
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let qv = { (k: String) in c.queryItems?.first { $0.name == k }?.value ?? "" }
        let id = String(qv("id").prefix(64))
        let port = UInt16(qv("p")) ?? 0
        let nonce = String(qv("k").prefix(64))
        let name = String(qv("n").prefix(64))
        let addrs = qv("a").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.range(of: "^[0-9a-fA-F.:]{3,45}$", options: .regularExpression) != nil }.prefix(6)
        guard !id.isEmpty, port > 0, !addrs.isEmpty else { return false }
        DispatchQueue.global().async {
            guard let address = addrs.first(where: { Self.reachable($0, port) }) else {
                DispatchQueue.main.async { self.message = "Can’t reach \(name.isEmpty ? "the computer" : name). Is the \(Device.word) on the same network?" }
                return
            }
            DispatchQueue.main.async {
                self.resumeUntil = .distantPast
                if var h = self.store.host(id) {
                    h.address = address
                    h.port = port
                    self.store.putHost(h)
                    self.link.connect(h)
                } else {
                    self.link.startPairing(address: address, port: port, name: name.isEmpty ? "Computer" : name, nonce: nonce)
                }
            }
        }
        return true
    }

    // A TCP connect within 800 ms.
    static func reachable(_ address: String, _ port: UInt16) -> Bool {
        let s = socket(address.contains(":") ? AF_INET6 : AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard s >= 0 else { return false }
        defer { close(s) }
        var tv = timeval(tv_sec: 0, tv_usec: 800_000)
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        if address.contains(":") {
            var a = sockaddr_in6()
            a.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            a.sin6_family = sa_family_t(AF_INET6)
            a.sin6_port = port.bigEndian
            guard inet_pton(AF_INET6, address, &a.sin6_addr) == 1 else { return false }
            return withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } } == 0
        }
        var a = sockaddr_in()
        a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        a.sin_family = sa_family_t(AF_INET)
        a.sin_port = port.bigEndian
        guard inet_pton(AF_INET, address, &a.sin_addr) == 1 else { return false }
        return withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
    }

    func confirmCode() { link.confirmCode() }
    func cancelPairing() { link.cancelPairing() }

    func forget(_ id: String) {
        if link.host?.id == id { disconnect() }
        store.forgetHost(id)
        if store.lastHostId == id { store.lastHostId = nil }
        refresh()
    }

    func dismissInvite() {
        if let f = invite { discovery.clearInvite(f.id) }
        invite = nil
    }

    func rename(_ name: String) {
        store.deviceName = name
        refresh()
    }

    private func onInvite(_ f: Found) {
        if let h = store.host(f.id) {
            if link.host?.id == h.id && (link.state == "connected" || link.state == "connecting") { return }
            var h = h
            h.address = f.address
            h.port = f.port
            store.putHost(h)
            return connect(h)
        }
        if link.pair != nil { return }
        invite = f
        Notifier.shared.invite(f.name)
    }

    // ---- LinkEvents (link queue) ----

    func linkChanged() { refresh() }

    func linkWelcome(_ host: Computer, _ m: JSON) {
        NSLog("TwinDesk: session with %@", host.name)
        DispatchQueue.main.async {
            self.resumeUntil = .distantPast
            self.invite = nil
            for f in self.features { f.onWelcome(host, m) }
            self.refresh()
            Background.shared.apply()
        }
    }

    func linkMessage(_ t: String, _ m: JSON) {
        DispatchQueue.main.async {
            for f in self.features where f.onMessage(t, m) { return }
        }
    }

    func linkClosed(_ host: Computer, _ code: String?) {
        DispatchQueue.main.async {
            for f in self.features { f.onClosed() }
            self.refresh()
            // An accident (Wi-Fi blip, the computer restarting): back within the grace, as Android does.
            let deliberate = [Proto.E.badToken, Proto.E.busy, Proto.E.replaced, Proto.E.released, Proto.E.asleep, "local", "identity"]
            if let c = code, deliberate.contains(c) { return }
            if self.resumeUntil == .distantPast { self.resumeUntil = Date().addingTimeInterval(Proto.phoneGrace) }
            self.resumeHost = host
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.resume() }
        }
    }

    private func resume() {
        guard let h = resumeHost, Date() < resumeUntil, link.state == "idle", link.pair == nil else {
            // Past the grace: keep trying now and then while kept alive in the background.
            if let h = resumeHost, link.state == "idle", link.pair == nil, Background.shared.active, store.lastHostId == h.id {
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.retryLater(h) }
            }
            return
        }
        let until = resumeUntil
        if usb.computerId == h.id, let fresh = store.host(h.id) { connectWired(fresh) } else { connect(store.host(h.id) ?? h) }
        resumeUntil = until
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.resume() }
    }

    private func retryLater(_ h: Computer) {
        guard link.state == "idle", link.pair == nil, store.lastHostId == h.id, let fresh = store.host(h.id) else { return }
        if discovery.get(h.id) != nil || Discovery.interfaces().isEmpty == false { connect(fresh) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.retryLater(h) }
    }
}
