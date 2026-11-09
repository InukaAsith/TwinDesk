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
    lazy var updates = Updates(self) // new releases on GitHub (About › Updates)
    lazy var peer = Peer(self) // another phone: its own link, one session with the computer's (Peer.swift)

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

    // Quiet links (Link.swift, #143): what keeps the session pinging every second. Clipboard,
    // notifications and cursor sharing switched on don't (their messages make it active at once).
    // inFront: on screen (the scene is active); read on the link's queue.
    private(set) var inFront = true
    private var busySnapshot = false
    // General › Connection › Prioritize performance over battery life (off): pings every second as before.
    var performance: Bool {
        get { store.flag("performance", false) }
        set { store.setFlag("performance", newValue); link.keepPinging = newValue; link.nudge(); changed() }
    }
    // General › Connection › Reconnect in the background (on). Off: a session that dropped is taken up
    // again only once TwinDesk is on screen.
    var reconnectBg: Bool {
        get { store.flag("reconnectBg", true) }
        set { store.setFlag("reconnectBg", newValue); changed() }
    }
    private var held: Bool { !reconnectBg && !inFront }
    private var resumeLater: Computer?

    // Main: what's live here, copied for the link's queue (Swift's main-thread state isn't read off it).
    func quietCheck() {
        let busy = inFront || screen.viewing || screen.sharing || remote.active || mic.running || mirror.sharing
        if busy != busySnapshot { busySnapshot = busy; link.nudge() }
        discovery.setSlow(!inFront) // off screen: a beacon a minute, no subnet sweeps (the radio stays asleep)
    }

    func setFront(_ on: Bool) {
        inFront = on
        if on { offScreenWork?.cancel(); offScreenWork = nil; unfocused = false; Notifier.shared.cancel("net.need") }
        quietCheck()
        if on {
            link.wake()
            updates.onScreen()
            if let h = resumeLater {
                resumeLater = nil
                if link.state == "idle", link.pair == nil, !peer.connected {
                    NSLog("TwinDesk: on screen: reconnecting")
                    if usb.computerId == h.id, let fresh = store.host(h.id) { connectWired(fresh) } else { connect(store.host(h.id) ?? h) }
                }
            }
        }
    }
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
        _ = Files.receivedDir // Files › On My iPad › TwinDesk › Received, there from the start
        discovery.start()
        remote.watchControllers()
        ble.start()
        _ = peer
        refresh()
        Background.shared.apply()
        link.keepPinging = performance
        link.busyHere = { [weak self] in self?.busySnapshot ?? true }
    }

    // The app woke (foreground, or in the background by location / audio / an intent): back on the
    // last computer if it's around and we're not connected.
    func wake() {
        start()
        discovery.refresh()
        // Back in front on Bluetooth (the network session dropped): onto the cable or the network again.
        if link.viaBle, link.connected, let h = link.host {
            if usb.computerId == h.id, let fresh = store.host(h.id) { connectWired(fresh) } else { offBle() }
        }
        if link.state == "idle", link.pair == nil, let id = store.lastHostId, let h = store.host(id),
           store.flag("autoConnect", true), !held, !peer.connected {
            if usb.computerId == id { connectWired(h) } else { connect(h) }
        }
    }

    func changed() { DispatchQueue.main.async { self.tick &+= 1; self.quietCheck() } }

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
            self.discovery.setSlow(!self.inFront)
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }

    @discardableResult
    func send(_ m: JSON) -> Bool { link.send(m) }

    // ---- actions ----

    // One session at a time: a phone's (Peer) ends when this one is welcomed (linkWelcome), and
    // nothing brings a computer back by itself while a phone holds it (resume, invites, the cable).
    func connect(_ h: Computer) {
        if usb.computerId == h.id { return connectWired(h, user: true) } // on the cable to it: through the cable
        resumeUntil = .distantPast
        var h = h
        // Linked over Bluetooth and not on this network (or no network at all: discovery keeps what it
        // saw a while after Wi-Fi goes off): the session through it.
        if ble.has(h.id), discovery.get(h.id) == nil || Discovery.interfaces().isEmpty { return connectBle(h) }
        if let f = discovery.get(h.id) { h.address = f.address; h.port = f.port; store.putHost(h) }
        // Saved at the cable's address (paired over Bluetooth or the cable, never seen on a network)
        // and the cable isn't in: 127.0.0.1 would only reach our own cable listener, a TLS error each
        // time. It waits for its Bluetooth link instead (linking connects it: bleLinked).
        else if h.address == "127.0.0.1" || h.address.isEmpty {
            NSLog("TwinDesk: %@ not on this network or the cable: waiting for Bluetooth", h.name)
            ble.start()
            return
        }
        if h.address == "127.0.0.1" { usb.aim(h.id) } // saved at the cable's address: only that computer's cable
        link.connect(h)
    }

    // Through a Bluetooth pipe (Ble): the computer's port reached on 127.0.0.1 here.
    func connectBle(_ h: Computer) {
        resumeUntil = .distantPast
        ble.openPipe(h.id) { [weak self] port in
            guard let self = self else { return }
            guard let port = port else { // no link after all: the network, if it was ever seen on one
                if h.address != "127.0.0.1", !h.address.isEmpty { self.link.connect(h) }
                return
            }
            var b = h
            b.address = "127.0.0.1"
            b.port = port
            // Connected on the network: the session moves onto the pipe without ending.
            if self.link.connected, self.link.host?.id == h.id {
                self.link.move(to: "127.0.0.1", port: port, ble: true) { ok in
                    if !ok { NSLog("TwinDesk: the session stays on the network (the move onto Bluetooth didn’t work)") }
                }
                return
            }
            NSLog("TwinDesk: session through Bluetooth")
            self.link.connect(b, force: true, ble: true)
        }
    }

    // A paired computer just linked over Bluetooth: connected through it if we're waiting for it
    // (not on this network: offBle moves it onto the network as soon as it's seen there).
    func bleLinked(_ id: String) {
        guard !link.connected, link.state != "connecting", discovery.get(id) == nil else { return }
        bleInvite(id)
    }

    // The computer asked over Bluetooth (its invite on CTRL, which also wakes the app): back on it
    // unless we left it on purpose or are with another.
    func bleInvite(_ id: String) {
        guard let h = store.host(id), link.pair == nil, store.lastHostId == id || store.lastHostId == nil && store.flag("autoConnect", true) else { return }
        if link.host?.id == id && (link.state == "connected" || link.state == "connecting") { return }
        if link.connected || peer.connected { return }
        connect(h)
    }

    // Off the screen, iOS's own way (General › Background › Off screen: Bluetooth, the default): the
    // session moves onto the Bluetooth link, which iOS keeps while TwinDesk is suspended and wakes it
    // for each thing that comes on it (bluetooth-central), the computer's pings included, so the
    // session lives on; back on Wi-Fi when TwinDesk is open again (wake). Not while the backups keep
    // the app running (the network stays), the microphone is recording (iOS keeps it running), the
    // screen is shared or files are on their way (they need the network). "Wi-Fi" keeps the session
    // on the network for as long as iOS lets the app run, Bluetooth only once it drops.
    var bleOffScreen: Bool { store.string("bg.mode", "ble") == "ble" }

    // Something that needs the network is going: the session stays on it. A screen either way
    // (Share Screen here, the computer's or a phone's screen watched here), the computer's sound
    // playing here, the camera, files, the microphone.
    private var networkBusy: Bool {
        mirror.sharing || mirror.starting || screen.viewing || sound.playing || camera.on || files.busy || mic.running || peer.screenOn
    }

    // Off screen (closed, in the background, locked) or out of focus: onto Bluetooth at once. The
    // session moves without ending (Link.move), so it costs nothing to go and come back. Out of focus
    // (the scene inactive: an iPad window that isn't the one in use, the app switcher) waits a moment,
    // so Control Center or a notification pulled down over TwinDesk doesn't move it.
    private var offScreenWork: DispatchWorkItem?
    private var unfocused = false
    func backgrounded() {
        offScreenWork?.cancel()
        offScreenWork = nil
        moveOffScreen()
    }

    func outOfFocus() {
        unfocused = true
        offScreenWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.moveOffScreen() }
        offScreenWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
    }

    private func moveOffScreen() {
        guard !inFront || unfocused, Background.shared.enabled, bleOffScreen, link.connected, !link.viaBle, link.pair == nil, let h = link.host, ble.has(h.id),
              !Background.shared.active, !networkBusy else { return }
        NSLog("TwinDesk: off screen: the session onto Bluetooth")
        connectBle(h)
    }

    // The computer holds files back until the session is on Wi-Fi (net.need, netlink.js): on screen,
    // the session moves now; off screen, a notification: opening TwinDesk moves it (wake).
    private func computerNeedsNetwork(_ m: JSON) {
        guard link.viaBle, link.connected, let h = link.host else { return }
        if (inFront && !unfocused) || mirror.sharing { return needNetwork() } // sharing this screen: its picture needs it now
        let title = m.str("why") == "screen" ? tr("{name} wants to show its screen", ["name": h.name]) : tr("{name} is sending files", ["name": h.name])
        Notifier.shared.note("net.need", title, tr("Open TwinDesk to receive them over Wi-Fi."), sound: true)
    }

    // Something that needs the network started while on Bluetooth (Share Screen, files): back on it.
    func needNetwork() {
        guard link.viaBle, link.connected else { return }
        wantNetwork = true
        discovery.refresh()
        offBle()
    }
    private var wantNetwork = false // needNetwork asked: off Bluetooth even off screen, once it's seen

    // On Bluetooth and the computer showed up on the network: the session moves back to it. Only
    // once discovery sees it here: its saved address on another network (or with Wi-Fi off) broke a
    // working Bluetooth session for one that can't connect, again at every discovery change.
    // Off screen (General › Background: Bluetooth) it stays on Bluetooth unless something needs the
    // network (needNetwork).
    private func offBle() {
        guard link.viaBle, link.connected, let h = link.host, let saved = store.host(h.id), let f = discovery.get(h.id) else { return }
        guard wantNetwork || (inFront && !unfocused) || !bleOffScreen || !Background.shared.enabled else { return }
        wantNetwork = false
        var w = saved
        w.address = f.address
        w.port = f.port
        store.putHost(w)
        guard !w.address.isEmpty, w.address != "127.0.0.1" else { return }
        NSLog("TwinDesk: back on the network from Bluetooth")
        // Without ending the session (what's under way on it carries on); a computer that can't
        // resume (an older one): a new session there, as before.
        link.move(to: w.address, port: w.port, ble: false) { [weak self] ok in
            if ok { self?.mirror.networkBack(); return }
            guard let self = self, !ok, self.link.viaBle, self.link.connected, self.link.host?.id == w.id else { return }
            if self.link.resumable { return } // it can, the network just didn't answer: stays on Bluetooth
            self.link.connect(w, force: true)
        }
    }

    // Onto the USB cable (Usb): the same computer at 127.0.0.1, the session moved there.
    func connectWired(_ h: Computer, user: Bool = false) {
        if peer.connected && !user { NSLog("TwinDesk: USB: a phone holds the session"); return }
        resumeUntil = .distantPast
        var w = h
        w.address = "127.0.0.1"
        w.port = Proto.port
        usb.aim(h.id)
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

    // Pair with a computer on the USB cable (Usb.unpaired): through the cable, any network or none.
    func pairUsb() { usb.pair() }

    // Pair with a computer found over Bluetooth (Ble.unpaired): through a Bluetooth pipe, for two
    // devices on different networks. The code is compared as over Wi-Fi; the session then stays on
    // Bluetooth until the computer turns up on this network (or the cable).
    func pairBle(_ id: String) {
        guard link.pair == nil, let name = ble.unpaired[id] else { return }
        ble.openPipe(id) { [weak self] port in
            guard let self = self, let port = port, self.link.pair == nil else { return }
            NSLog("TwinDesk: pairing through Bluetooth")
            self.link.startPairing(address: "127.0.0.1", port: port, name: name, ble: true)
        }
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
                DispatchQueue.main.async { self.message = tr("Can’t reach {name}. Is the {device} on the same network?", ["name": name.isEmpty ? tr("the computer") : name, "device": Device.word]) }
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
            if peer.connected { return } // a phone holds the session: Connect here takes it back
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
            if self.peer.connected { NSLog("TwinDesk: ending the phone session for %@", host.name); self.peer.disconnect() }
            for f in self.features { f.onWelcome(host, m) }
            self.refresh()
            Background.shared.apply()
        }
    }

    func linkMessage(_ t: String, _ m: JSON) {
        DispatchQueue.main.async {
            if t == "net.need" { return self.computerNeedsNetwork(m) }
            if t.hasPrefix("net.") { return } // the computers' Wi-Fi links (netlink.js): nothing more here
            for f in self.features where f.onMessage(t, m) { return }
        }
    }

    func linkClosed(_ host: Computer, _ code: String?) {
        DispatchQueue.main.async {
            for f in self.features { f.onClosed() }
            // The session on the cable (not Bluetooth's pipe, also on 127.0.0.1) failed: maybe unplugged.
            if code != "local", host.address == "127.0.0.1", host.port == Proto.port { self.usb.sessionFailed() }
            self.refresh()
            // An accident (Wi-Fi blip, the computer restarting): back within the grace, as Android does.
            let deliberate = [Proto.E.badToken, Proto.E.busy, Proto.E.replaced, Proto.E.released, Proto.E.asleep, "local", "identity"]
            if let c = code, deliberate.contains(c) { return }
            if self.held { self.resumeLater = host; NSLog("TwinDesk: dropped in the background: reconnecting when on screen"); return }
            if self.resumeUntil == .distantPast { self.resumeUntil = Date().addingTimeInterval(Proto.phoneGrace) }
            self.resumeHost = host
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.resume() }
        }
    }

    private func resume() {
        if held, let h = resumeHost { resumeLater = h; return }
        guard let h = resumeHost, Date() < resumeUntil, link.state == "idle", link.pair == nil, !peer.connected else {
            // Past the grace: keep trying now and then while kept alive in the background.
            if let h = resumeHost, link.state == "idle", link.pair == nil, Background.shared.active, store.lastHostId == h.id {
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.retryLater(h) }
            }
            return
        }
        let until = resumeUntil
        if usb.computerId == h.id, let fresh = store.host(h.id) { connectWired(fresh) }
        // Dropped and linked over Bluetooth: back through it at once (offBle moves it onto the network
        // again as soon as discovery sees the computer there).
        else if ble.has(h.id) { connectBle(store.host(h.id) ?? h) }
        else { connect(store.host(h.id) ?? h) }
        resumeUntil = until
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.resume() }
    }

    private func retryLater(_ h: Computer) {
        if held { resumeLater = h; return }
        guard link.state == "idle", link.pair == nil, !peer.connected, store.lastHostId == h.id, let fresh = store.host(h.id) else { return }
        if discovery.get(h.id) != nil || Discovery.interfaces().isEmpty == false { connect(fresh) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.retryLater(h) }
    }
}
